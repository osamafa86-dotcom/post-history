import { Inject, Injectable } from '@nestjs/common';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { passkeys, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import type { RateLimiter } from './rate-limiter';
import { RateLimitsService } from './rate-limits.service';
import { AuthService } from './auth.service';
import { CredentialAttempts } from './credential-attempts';
import { audit } from './recovery-approval';
import { SessionService } from './session.service';
import { matchesChallenge, WebAuthnChallenges } from './webauthn-challenges';

type Passkey = components['schemas']['Passkey'];
type PasskeyChallenge = components['schemas']['PasskeyChallenge'];
type Session = components['schemas']['Session'];
type Credential = components['schemas']['WebAuthnCredential'];

/** حد مفاتيح الحساب الفاعلة؛ العقد يقول عشرة (`PasskeyList.maxItems`). */
export const MAX_PASSKEYS = 10;
// خوارزميات COSE صريحة في الإنشاء والتحقق معًا: EdDSA وES256 وRS256 (لا يتغيّر الافتراض بتغيّر بيئة Node)
const ALGORITHMS = [-8, -7, -257];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT = /^[a-z-]{1,32}$/;

const expired = () => new ApiError(410, 'challenge_expired', 'The challenge expired or was already used; request a new one.');
const rateLimited = (wait: number) => new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });

/** معرّف المستخدم في WebAuthn (`user.id`): بايتات UUID الستة عشر، معتم ولا بيانات شخصية فيه. */
export function userHandle(userId: string): Buffer {
  return Buffer.from(userId.replace(/-/g, ''), 'hex');
}

/**
 * مفاتيح المرور (WebAuthn، ADR 0107) بمكتبة `@simplewebauthn/server` المثبّتة الإصدار. RP ID ومصادره من البيئة، والتحدي ببصمته
 * لمرة واحدة. لا يدخل سجلًا ولا تدقيقًا ولا حدثًا شيء من التحدي أو معرّف الاعتماد أو رد المتصفح: أخطاء المكتبة تحمل التحدي في
 * رسائلها، فتُبتلع كلها وتصير رمزًا ثابتًا ولا يُرمى خطؤها الأصلي أبدًا (مرشّح الأخطاء يسجّل مكدّس 5xx).
 */
@Injectable()
export class PasskeysService {
  private readonly challenges: WebAuthnChallenges;
  private readonly optionsByUser: RateLimiter;
  private readonly loginOptionsByIp: RateLimiter;
  private readonly loginByIp: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    limits: RateLimitsService,
    private readonly attempts: CredentialAttempts,
  ) {
    this.challenges = new WebAuthnChallenges(config.PASSKEY_CHALLENGE_TTL_SECONDS);
    this.optionsByUser = limits.create('passkey-options-user', config.PASSKEY_RATE_LIMIT_MAX);
    this.loginOptionsByIp = limits.create('passkey-login-options-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
    this.loginByIp = limits.create('passkey-login-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
  }

  // ---------- التسجيل ----------

  /**
   * إعادة التحقق (كلمة المرور ثم TOTP إن فُعّل، بعدّادي الفشل لكل حساب نفسيهما في الدخول ورمز يحجز خطوته، ADR 0117) ثم خيارات
   * الإنشاء بتحدٍّ لهذا المستخدم.
   */
  async registrationOptions(userId: string, body: components['schemas']['PasskeyStepUp']): Promise<PasskeyChallenge> {
    const rpID = this.rpId();
    const wait = await this.optionsByUser.retryAfter(userId);
    if (wait > 0) throw rateLimited(wait);
    const user = await this.attempts.stepUp(userId, body);
    await this.optionsByUser.record(userId);

    const active = await this.db
      .select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
      .from(passkeys)
      .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)));
    if (active.length >= MAX_PASSKEYS) throw limitReached();

    const options = await generateRegistrationOptions({
      rpName: this.config.WEBAUTHN_RP_NAME,
      rpID,
      userName: user.email,
      userID: new Uint8Array(userHandle(userId)),
      challenge: new Uint8Array(randomBytes(32)),
      timeout: this.config.PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
      attestationType: 'none',
      excludeCredentials: active.map((c) => ({ id: c.credentialId.toString('base64url'), transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    const saved = await this.challenges.save(this.db, 'registration', userId, options.challenge);
    return { challenge_id: saved.id, public_key: options as unknown as Record<string, unknown>, expires_at: saved.expiresAt };
  }

  /**
   * يتحقق من رد الإنشاء ويحفظ المفتاح: معاملة واحدة بالمفتاح والتدقيق بمعرّفه الداخلي وحدث auth.passkey_added. التحدي يُستهلك
   * قبل التحقق، فالرد الفاشل لا يُعاد به.
   */
  async register(userId: string, body: components['schemas']['PasskeyRegistration']): Promise<Passkey> {
    const rpID = this.rpId();
    const hash = await this.challenges.consume(this.db, body.challenge_id, 'registration', userId);
    if (!hash) throw expired();

    let info: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'];
    try {
      const result = await verifyRegistrationResponse({
        response: body.credential as unknown as RegistrationResponseJSON,
        expectedChallenge: matchesChallenge(hash),
        expectedOrigin: this.config.WEBAUTHN_ORIGINS,
        expectedRPID: rpID,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
      info = result.verified ? result.registrationInfo : undefined;
    } catch {
      info = undefined;
    }
    if (!info) throw ApiError.validation({ fields: ['/credential'] });

    const credentialId = Buffer.from(info.credential.id, 'base64url');
    const transports = (info.credential.transports ?? []).filter((t) => TRANSPORT.test(t)).slice(0, 8);
    try {
      return await this.db.transaction(async (tx) => {
        // قفل المستخدم يسلسل التسجيلات المتزامنة فلا يتجاوز الحد
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
        const [held] = await tx
          .select({ n: count() })
          .from(passkeys)
          .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)));
        if ((held?.n ?? 0) >= MAX_PASSKEYS) throw limitReached();
        const [row] = await tx
          .insert(passkeys)
          .values({
            userId,
            credentialId,
            publicKey: Buffer.from(info.credential.publicKey),
            signCount: info.credential.counter,
            transports,
            multiDevice: info.credentialDeviceType === 'multiDevice',
            backedUp: info.credentialBackedUp,
            name: body.name ?? null,
          })
          .returning();
        await audit(tx, userId, 'auth.passkey_added', userId, { target_user_id: userId, passkey_id: row!.id });
        await writeOutboxEvent(tx, {
          type: 'auth.passkey_added',
          aggregateType: 'user',
          aggregateId: userId,
          idempotencyKey: `auth.passkey_added:${row!.id}`,
          actorId: userId,
          payload: { passkey_id: row!.id },
        });
        return toPasskey(row!);
      });
    } catch (err) {
      if (pgError(err).constraint === 'passkeys_credential_id_key') {
        throw new ApiError(409, 'passkey_exists', 'This passkey is already registered.');
      }
      throw err;
    }
  }

  async list(userId: string): Promise<Passkey[]> {
    const rows = await this.db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)))
      .orderBy(desc(passkeys.createdAt));
    return rows.map(toPasskey);
  }

  /** يبطل مفتاحًا للمستدعي؛ غير الموجود أو لغيره أو المبطَل 404. معاملة واحدة بالتدقيق والحدث. */
  async revoke(userId: string, passkeyId: string): Promise<void> {
    if (!UUID.test(passkeyId)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(passkeys)
        .set({ revokedAt: sql`now()`, revokedReason: 'owner' })
        .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId), isNull(passkeys.revokedAt)))
        .returning({ id: passkeys.id });
      if (!row) throw ApiError.notFound();
      await audit(tx, userId, 'auth.passkey_revoked', userId, { target_user_id: userId, passkey_id: row.id, reason_code: 'owner' });
      await writeOutboxEvent(tx, {
        type: 'auth.passkey_revoked',
        aggregateType: 'user',
        aggregateId: userId,
        idempotencyKey: `auth.passkey_revoked:${row.id}`,
        actorId: userId,
        payload: { passkey_id: row.id },
      });
    });
  }

  // ---------- الدخول ----------

  /** خيارات الطلب بلا قائمة مفاتيح (المفتاح يُكتشف على الجهاز)، فلا يُسأل عن بريد ولا يُكشف حساب. */
  async loginOptions(ip: string): Promise<PasskeyChallenge> {
    const rpID = this.rpId();
    const wait = await this.loginOptionsByIp.retryAfter(ip);
    if (wait > 0) throw rateLimited(wait);
    await this.loginOptionsByIp.record(ip);
    const options = await generateAuthenticationOptions({
      rpID,
      challenge: new Uint8Array(randomBytes(32)),
      timeout: this.config.PASSKEY_CHALLENGE_TTL_SECONDS * 1000,
      userVerification: 'required',
    });
    const saved = await this.challenges.save(this.db, 'authentication', null, options.challenge);
    return { challenge_id: saved.id, public_key: options as unknown as Record<string, unknown>, expires_at: saved.expiresAt };
  }

  /**
   * الدخول بمفتاح: كل رفض بعد التحدي 401 واحد بالرسالة نفسها، ويُعد في حد المعدل لكل عنوان. المفتاح بالتحقق من المستخدم عاملان،
   * فالجلسة كاملة بلا TOTP. العدّاد يُحدَّث بشرط قيمته السابقة، فدخولان متزامنان بالرد نفسه ينجح أحدهما فقط.
   */
  async login(body: components['schemas']['PasskeyAssertion'], ip: string): Promise<Session> {
    const rpID = this.rpId();
    const wait = await this.loginByIp.retryAfter(ip);
    if (wait > 0) throw rateLimited(wait);
    const fail = async (): Promise<never> => {
      await this.loginByIp.record(ip);
      throw ApiError.unauthorized();
    };
    const hash = await this.challenges.consume(this.db, body.challenge_id, 'authentication', null);
    if (!hash) {
      await this.loginByIp.record(ip);
      throw expired();
    }
    const credential = body.credential as Credential;
    const [key] = await this.db
      .select({
        id: passkeys.id,
        userId: passkeys.userId,
        publicKey: passkeys.publicKey,
        signCount: passkeys.signCount,
        transports: passkeys.transports,
        status: users.status,
        membershipSuspended: users.membershipSuspended,
        credentialResetRequired: users.credentialResetRequired,
      })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(and(eq(passkeys.credentialId, Buffer.from(credential.id, 'base64url')), isNull(passkeys.revokedAt)));
    if (!key) return fail();
    // المفتاح القابل للاكتشاف يعيد معرّف المستخدم الذي أُنشئ له؛ إن حضر فيجب أن يطابق صاحب المفتاح
    const handle = credential.response?.userHandle;
    if (typeof handle === 'string' && handle && !userHandle(key.userId).equals(Buffer.from(handle, 'base64url'))) return fail();

    let verified: { newCounter: number; backedUp: boolean } | null = null;
    try {
      const result = await verifyAuthenticationResponse({
        response: credential as unknown as AuthenticationResponseJSON,
        expectedChallenge: matchesChallenge(hash),
        expectedOrigin: this.config.WEBAUTHN_ORIGINS,
        expectedRPID: rpID,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(key.publicKey),
          counter: key.signCount,
          transports: key.transports,
        },
        requireUserVerification: true,
      });
      if (result.verified) {
        verified = { newCounter: result.authenticationInfo.newCounter, backedUp: result.authenticationInfo.credentialBackedUp };
      }
    } catch {
      verified = null;
    }
    // الحساب المعلّق أو في «إعادة التعيين الإلزامية» بالرد نفسه، فلا يُكشف حاله
    if (!verified || key.status !== 'active' || key.membershipSuspended || key.credentialResetRequired) return fail();

    const issued = await this.db.transaction(async (tx) => {
      const [used] = await tx
        .update(passkeys)
        .set({ signCount: verified!.newCounter, lastUsedAt: sql`now()`, backedUp: sql`${verified!.backedUp} AND ${passkeys.multiDevice}` })
        .where(and(eq(passkeys.id, key.id), isNull(passkeys.revokedAt), eq(passkeys.signCount, key.signCount)))
        .returning({ id: passkeys.id });
      if (!used) return null;
      const tokens = await this.sessions.issue(tx, key.userId);
      await tx.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, key.userId));
      return tokens;
    });
    if (!issued) return fail();
    await this.loginByIp.reset(ip);
    return this.auth.toSession(key.userId, issued);
  }

  /** RP ID من البيئة؛ غير مضبوط = مفاتيح المرور معطّلة، فالعمليات 404 كأنها غير موجودة. */
  private rpId(): string {
    if (!this.config.WEBAUTHN_RP_ID) throw ApiError.notFound();
    return this.config.WEBAUTHN_RP_ID;
  }
}

const limitReached = () => new ApiError(409, 'passkey_limit_reached', `An account holds at most ${MAX_PASSKEYS} passkeys.`);

function toPasskey(row: typeof passkeys.$inferSelect): Passkey {
  return {
    id: row.id,
    name: row.name,
    multi_device: row.multiDevice,
    created_at: iso(row.createdAt)!,
    last_used_at: iso(row.lastUsedAt),
  };
}
