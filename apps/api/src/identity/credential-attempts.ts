import { Inject, Injectable } from '@nestjs/common';
import { verify as argon2Verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig, fieldKeyring } from '../config/config';
import { type FieldKeyring, totpStep } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { users } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { BackoffPolicy, RateLimiter } from './rate-limiter';
import { RateLimitsService } from './rate-limits.service';

// الرمز مقبول في خطوته والخطوتين المجاورتين (totpStep)، فأطول عمر له 90 ث؛ هامش فوقها. المفتاح بالخطوة نفسها لا بالرمز.
const TOTP_REUSE_MS = 120_000;

const rateLimited = (wait: number) => new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });

/**
 * عدّادا فشل لكل حساب مستقلان عن العنوان (ADR 0117): كلمة المرور، ورمز TOTP، بتأخير متضاعف بعد محاولات مجانية حتى سقف. الدخول
 * وإعادة التحقق (قبل تسجيل مفتاح مرور وقبل توليد الرموز الاحتياطية) وتأكيد TOTP بعد الاستعادة تشترك فيهما، فلا تصير إحداها طريقًا
 * للتخمين حول الأخرى. مفتاح كلمة المرور معرّف الحساب إن وُجد، وإلا البريد المطبَّع، فالبريد غير الموجود يُعدّ ويُؤخَّر كالموجود.
 * والرمز المقبول يحجز (المستخدم، الخطوة الزمنية) قبل القبول، فلا يُقبل ثانية في نافذته.
 */
@Injectable()
export class CredentialAttempts {
  private readonly password: RateLimiter;
  private readonly totp: RateLimiter;
  private readonly stepUpByUser: RateLimiter;
  private readonly fieldKeys: FieldKeyring;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly limits: RateLimitsService,
  ) {
    const policy: BackoffPolicy = {
      free: config.LOGIN_BACKOFF_FREE_ATTEMPTS,
      baseMs: config.LOGIN_BACKOFF_BASE_SECONDS * 1000,
      maxMs: config.LOGIN_BACKOFF_MAX_SECONDS * 1000,
      forgetMs: config.LOGIN_BACKOFF_RESET_SECONDS * 1000,
    };
    this.password = limits.backoff('account-password', policy);
    this.totp = limits.backoff('account-totp', policy);
    // إعادة التحقق الفاشلة لكل حساب في نافذة الدخول (ADR 0107)، فوق العدّادين
    this.stepUpByUser = limits.create('passkey-step-up-user', config.LOGIN_RATE_LIMIT_MAX);
    this.fieldKeys = fieldKeyring(config);
  }

  /** مفتاح عدّاد كلمة المرور: الحساب إن وُجد، وإلا البريد المطبَّع (بادئة لا تلتبس بمعرّف). */
  accountKey(userId: string | undefined, normalizedEmail: string): string {
    return userId ?? `email:${normalizedEmail}`;
  }

  /** ثواني الانتظار قبل أي تحقق لهذا الحساب: أكبر العدّادين. */
  async wait(account: string, userId?: string): Promise<number> {
    const [p, t] = await Promise.all([this.password.retryAfter(account), userId ? this.totp.retryAfter(userId) : Promise.resolve(0)]);
    return Math.max(p, t);
  }

  totpWait(userId: string): Promise<number> {
    return this.totp.retryAfter(userId);
  }

  passwordFailed(account: string): Promise<void> {
    return this.password.record(account);
  }

  totpFailed(userId: string): Promise<void> {
    return this.totp.record(userId);
  }

  /** نجاح كامل (كلمة المرور ثم TOTP إن فُعّل، أو إكمال الاستعادة): يُنسى العدّادان. */
  async succeeded(account: string, userId: string): Promise<void> {
    await Promise.all([this.password.reset(account), this.totp.reset(userId)]);
  }

  /** يطابق الرمز خطوة ويحجز (المستخدم، الخطوة) لأول استعمال؛ false للخاطئ وللمُعاد في نافذته على السواء. */
  async acceptTotp(userId: string, secret: Buffer, code: string): Promise<boolean> {
    const step = totpStep(secret, code);
    if (step === null) return false;
    return this.limits.firstUse('totp-step', `${userId}:${step}`, TOTP_REUSE_MS);
  }

  /**
   * إعادة التحقق لصاحب جلسة قبل إضافة وسيلة دخول أو توليد رموز احتياطية: كلمة المرور، ثم TOTP إن فُعّل (غيابه بعد كلمة مرور صحيحة
   * `401 totp_required` ولا يُعد فشلًا). الفشل `401` ويُعد في العدّادين ونافذة إعادة التحقق؛ والنجاح ينسيها. يعيد بريد الحساب.
   */
  async stepUp(userId: string, body: components['schemas']['PasskeyStepUp'] | undefined): Promise<{ email: string }> {
    const wait = Math.max(await this.stepUpByUser.retryAfter(userId), await this.wait(userId, userId));
    if (wait > 0) throw rateLimited(wait);
    const [user] = await this.db
      .select({ email: users.email, passwordHash: users.passwordHash, totpEnabled: users.totpEnabled, totpSecretEnc: users.totpSecretEnc })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw ApiError.unauthorized();
    const fail = async (step: 'password' | 'totp'): Promise<never> => {
      await Promise.all([this.stepUpByUser.record(userId), step === 'password' ? this.passwordFailed(userId) : this.totpFailed(userId)]);
      throw ApiError.unauthorized();
    };
    if (!body || !(await argon2Verify(user.passwordHash, body.password).catch(() => false))) await fail('password');
    if (user.totpEnabled) {
      if (!body!.totp_code) throw new ApiError(401, 'totp_required', 'TOTP code required.');
      if (!(await this.acceptTotp(userId, this.fieldKeys.decrypt(user.totpSecretEnc!), body!.totp_code))) await fail('totp');
    }
    await Promise.all([this.stepUpByUser.reset(userId), this.succeeded(userId, userId)]);
    return { email: user.email };
  }
}
