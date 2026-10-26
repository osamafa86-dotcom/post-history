import { Inject, Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig, fieldKeyring } from '../config/config';
import { base32Encode, type FieldKeyring, randomToken, sha256, verifyTotp } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { recoveryRequests, userPermissions, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { RateLimiter } from './rate-limiter';
import { RateLimitsService } from './rate-limits.service';
import { writeOutboxEvent } from '../outbox/outbox';
import { audit } from './recovery-approval';
import { type IssuedTokens, SessionService } from './session.service';

type Session = components['schemas']['Session'];
type Me = components['schemas']['Me'];
type Role = components['schemas']['Role'];
type LoginRequest = components['schemas']['LoginRequest'];
type RecoveryCompletion = components['schemas']['RecoveryCompletion'];

const TOTP_ISSUER = 'PostHistory';
// 160 بت كما توصي RFC 4226؛ 32 حرفًا بترميز base32
const TOTP_SECRET_BYTES = 20;

@Injectable()
export class AuthService {
  // المحاولات الفاشلة لكل (بريد، عنوان)، ولكل عنوان بحد أعلى ضد رش كلمات المرور على حسابات كثيرة
  private readonly byIp: RateLimiter;
  private readonly byEmailIp: RateLimiter;
  private readonly completeByIp: RateLimiter;
  private readonly completeByToken: RateLimiter;
  private readonly confirmByUser: RateLimiter;
  private readonly fieldKeys: FieldKeyring;
  // يُتحقق منه عند غياب المستخدم حتى لا يكشف زمن الاستجابة وجود البريد
  private readonly dummyHash: Promise<string>;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly sessions: SessionService,
    limits: RateLimitsService,
  ) {
    this.byIp = limits.create('login-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
    this.byEmailIp = limits.create('login-email-ip', config.LOGIN_RATE_LIMIT_MAX);
    // العنوان قد يجمع مكتبًا خلف NAT فحدّه واسع كحد الدخول لكل عنوان؛ الحد الضيق ببصمة الرمز
    this.completeByIp = limits.create('recovery-complete-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
    this.completeByToken = limits.create('recovery-complete-token', config.LOGIN_RATE_LIMIT_MAX);
    this.confirmByUser = limits.create('totp-confirm-user', config.LOGIN_RATE_LIMIT_MAX);
    this.fieldKeys = fieldKeyring(config);
    this.dummyHash = argon2Hash(randomToken());
  }

  async login(body: LoginRequest, ip: string): Promise<Session> {
    const email = body.email.trim().toLowerCase();
    const ipKey = ip;
    const pairKey = `${email}|${ip}`;
    const wait = Math.max(await this.byIp.retryAfter(ipKey), await this.byEmailIp.retryAfter(pairKey));
    if (wait > 0) {
      throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
    }

    const [user] = await this.db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        status: users.status,
        totpEnabled: users.totpEnabled,
        totpSecretEnc: users.totpSecretEnc,
        credentialResetRequired: users.credentialResetRequired,
      })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);

    const fail = async (): Promise<never> => {
      await Promise.all([this.byIp.record(ipKey), this.byEmailIp.record(pairKey)]);
      throw ApiError.unauthorized();
    };

    const passwordOk = await argon2Verify(user?.passwordHash ?? (await this.dummyHash), body.password).catch(() => false);
    // في «إعادة التعيين الإلزامية» لا دخول عاديًا: الطريق /auth/recovery/complete ثم /auth/totp/confirm (الرد نفسه
    // فلا يُكشف أن الحساب في استعادة)
    if (!user || !passwordOk || user.status !== 'active' || user.credentialResetRequired) await fail();

    if (user!.totpEnabled) {
      // غياب الرمز بعد كلمة مرور صحيحة ليس تخمينًا فلا يُعد فشلًا
      if (!body.totp_code) throw new ApiError(401, 'totp_required', 'TOTP code required.');
      const secret = this.fieldKeys.decrypt(user!.totpSecretEnc!);
      if (!verifyTotp(secret, body.totp_code)) await fail();
    }
    await this.byEmailIp.reset(pairKey);

    return this.db.transaction(async (tx) => {
      const issued = await this.sessions.issue(tx, user!.id);
      await tx.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user!.id));
      return this.toSession(user!.id, issued);
    });
  }

  async refresh(refreshToken: string): Promise<Session> {
    const issued = await this.sessions.refresh(refreshToken);
    if (!issued) throw ApiError.unauthorized();
    return this.toSession(issued.userId, issued);
  }

  async logout(userId: string, sessionId: string, allSessions: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (allSessions) await this.sessions.revokeAll(tx, userId);
      else await this.sessions.revokeChain(tx, sessionId);
    });
  }

  async me(userId: string): Promise<Me> {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        officeId: users.officeId,
        organizationId: users.organizationId,
        totpEnabled: users.totpEnabled,
        credentialResetRequired: users.credentialResetRequired,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw ApiError.unauthorized();
    const perms = await this.db
      .select({ permission: userPermissions.permission })
      .from(userPermissions)
      .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt)));
    return {
      user_id: user.id,
      email: user.email,
      office_id: user.officeId,
      organization_id: user.organizationId,
      totp_enabled: user.totpEnabled,
      credential_reset_required: user.credentialResetRequired,
      roles: await this.roles(userId),
      permissions: perms.map((p) => p.permission as Me['permissions'][number]),
    };
  }

  // ---------- إكمال الاستعادة (v0.1) ----------

  /**
   * يستهلك رمز إعادة التعيين مرة واحدة: كلمة مرور جديدة، وسر TOTP جديد معلّق، وإبطال السر القديم فورًا (فلا دخول عاديًا
   * حتى /auth/totp/confirm)، وجلسة مقيّدة. الرمز المجهول أو المستهلك أو المنتهي 401 واحد لا يميّز بينها، ويُعد في حد
   * المعدل لكل عنوان. الرمز وكلمة المرور والسر لا يدخل شيء منها سجلًا أو تدقيقًا.
   */
  async completeRecovery(resetToken: string, newPassword: string, ip: string): Promise<RecoveryCompletion> {
    // حد المعدل بالعنوان وببصمة الرمز (ADR 0012): رمز بعينه لا يُجرَّب عليه من عناوين كثيرة
    const tokenKey = sha256(resetToken).toString('hex');
    const wait = Math.max(await this.completeByIp.retryAfter(ip), await this.completeByToken.retryAfter(tokenKey));
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });

    const usable = and(
      eq(recoveryRequests.resetTokenHash, sha256(resetToken)),
      eq(recoveryRequests.state, 'approved'),
      isNull(recoveryRequests.completedAt),
      gt(recoveryRequests.resetTokenExpiresAt, sql`now()`),
      eq(users.status, 'active'),
      eq(users.credentialResetRequired, true),
    );
    const rejected = async (): Promise<never> => {
      await Promise.all([this.completeByIp.record(ip), this.completeByToken.record(tokenKey)]);
      throw ApiError.unauthorized();
    };
    // فحص رخيص قبل argon2: الرمز الخاطئ لا يكلّف تجزئة كلمة مرور
    const [candidate] = await this.db
      .select({ id: recoveryRequests.id })
      .from(recoveryRequests)
      .innerJoin(users, eq(users.id, recoveryRequests.userId))
      .where(usable);
    if (!candidate) await rejected();

    const secret = randomBytes(TOTP_SECRET_BYTES);
    const passwordHash = await argon2Hash(newPassword);
    const done = await this.db.transaction(async (tx) => {
      // يُعاد الشرط تحت القفل: إكمالان متزامنان للرمز نفسه، ينجح أحدهما فقط
      const [r] = await tx
        .select({
          id: recoveryRequests.id,
          userId: recoveryRequests.userId,
          approvedBy: recoveryRequests.approvedBy,
          email: users.email,
          officeId: users.officeId,
        })
        .from(recoveryRequests)
        .innerJoin(users, eq(users.id, recoveryRequests.userId))
        .where(usable)
        .for('update', { of: recoveryRequests });
      if (!r) return null;
      await tx.update(recoveryRequests).set({ completedAt: sql`now()` }).where(eq(recoveryRequests.id, r.id));
      await tx
        .update(users)
        .set({ passwordHash, totpEnabled: false, totpSecretEnc: null, totpPendingSecretEnc: this.fieldKeys.encrypt(secret) })
        .where(eq(users.id, r.userId));
      // التدقيق بمعرّف الطلب والمعتمِد فيُقرأ أي استيلاء من السجل، والحدث يُنبّه صاحب الحساب (ضوابط ADR 0012)
      await audit(tx, r.userId, 'auth.recovery_completed', r.userId, {
        recovery_request_id: r.id,
        target_user_id: r.userId,
        ...(r.approvedBy ? { approved_by: r.approvedBy } : {}),
      });
      await writeOutboxEvent(tx, {
        type: 'auth.recovery_completed',
        aggregateType: 'user',
        aggregateId: r.userId,
        idempotencyKey: `auth.recovery_completed:${r.id}`,
        actorId: r.userId,
        payload: { recovery_request_id: r.id, ...(r.officeId ? { office_id: r.officeId } : {}) },
      });
      const issued = await this.sessions.issue(tx, r.userId);
      return { userId: r.userId, email: r.email, issued };
    });
    if (!done) return rejected();
    const secretBase32 = base32Encode(secret);
    return {
      session: await this.toSession(done.userId, done.issued),
      totp_enrollment: {
        secret_base32: secretBase32,
        otpauth_uri: `otpauth://totp/${encodeURIComponent(`${TOTP_ISSUER}:${done.email}`)}?secret=${secretBase32}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`,
      },
    };
  }

  /**
   * يؤكد سر TOTP المعلّق برمز منه: يصير السر الفاعل، ويُرفع القيد، وتُبطل الجلسة المقيّدة (وكل وصول آخر للحساب) وتصدر
   * جلسة كاملة جديدة. خارج «إعادة التعيين الإلزامية» 409، والرمز الخاطئ 401 ويُعد في حد المعدل لكل حساب.
   */
  async confirmTotp(userId: string, code: string): Promise<Session> {
    const wait = await this.confirmByUser.retryAfter(userId);
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
    const notPending = () => new ApiError(409, 'recovery_state_conflict', 'No two-factor enrollment is pending for this account.');

    const [u] = await this.db
      .select({ pending: users.totpPendingSecretEnc, resetRequired: users.credentialResetRequired })
      .from(users)
      .where(eq(users.id, userId));
    if (!u?.resetRequired || !u.pending) throw notPending();
    if (!verifyTotp(this.fieldKeys.decrypt(u.pending), code)) {
      await this.confirmByUser.record(userId);
      throw ApiError.unauthorized();
    }
    const issued = await this.db.transaction(async (tx) => {
      const [confirmed] = await tx
        .update(users)
        .set({ totpSecretEnc: u.pending, totpEnabled: true, totpPendingSecretEnc: null, credentialResetRequired: false })
        .where(and(eq(users.id, userId), eq(users.credentialResetRequired, true), eq(users.totpPendingSecretEnc, u.pending!)))
        .returning({ id: users.id });
      // تأكيد متزامن آخر سبق إليه
      if (!confirmed) return null;
      await this.sessions.revokeAll(tx, userId);
      await audit(tx, userId, 'auth.totp_confirmed', userId, { target_user_id: userId });
      return this.sessions.issue(tx, userId);
    });
    if (!issued) throw notPending();
    await this.confirmByUser.reset(userId);
    return this.toSession(userId, issued);
  }

  private async toSession(userId: string, issued: IssuedTokens): Promise<Session> {
    return {
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_at: issued.accessExpiresAt.toISOString(),
      user_id: userId,
      roles: await this.roles(userId),
    };
  }

  private async roles(userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: userRoles.role, scopeKind: userRoles.scopeKind, scopeId: userRoles.scopeId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId))
      .orderBy(userRoles.role, userRoles.scopeKind, userRoles.scopeId);
    const byName = new Map<string, Role>();
    for (const r of rows) {
      const role = byName.get(r.role) ?? { name: r.role as Role['name'], scopes: [] };
      byName.set(r.role, role);
      if (r.scopeKind !== 'all') role.scopes.push({ kind: r.scopeKind as 'office' | 'governorate' | 'organization', id: r.scopeId });
    }
    // دور بنطاق 'all' يرى كل شيء: قائمة نطاقات فارغة (العقد)
    for (const r of rows) if (r.scopeKind === 'all') byName.get(r.role)!.scopes = [];
    return [...byName.values()];
  }
}
