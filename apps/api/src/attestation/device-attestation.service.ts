import { Inject, Injectable } from '@nestjs/common';
import { createHash, X509Certificate } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { auditLog, deviceAttestationKeys, uploadSessions, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { ReplayRehydrator } from '../idempotency/replay';
import { RateLimitsService } from '../identity/rate-limits.service';
import type { RateLimiter } from '../identity/rate-limiter';
import type { Principal } from '../identity/principal';
import { SessionService } from '../identity/session.service';
import { APPLE_APP_ATTEST_ROOT_PEM, type AppAttestPolicy, AttestationRejected, verifyAssertion, verifyAttestation } from './app-attest';
import { ChallengeStore } from './challenge-store';
import { IngestTokenSigner } from './ingest-token';
import { AttestationUnavailable, checkPlayVerdict, GooglePlayIntegrityDecoder, type PlayIntegrityDecoder, UnsignedTestDecoder } from './play-integrity';

type AttestationChallenge = components['schemas']['AttestationChallenge'];
type IngestToken = components['schemas']['IngestToken'];
type KeyRegistration = components['schemas']['AttestationKeyRegistration'];
type IngestTokenRequest = components['schemas']['IngestTokenRequest'];

export const PLAY_INTEGRITY_DECODER = Symbol('PLAY_INTEGRITY_DECODER');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const WEB_TOKEN_MAX_SECONDS = 600;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

const failed = () => new ApiError(403, 'attestation_failed', 'Device attestation failed.');
const expired = () => new ApiError(410, 'challenge_expired', 'The challenge expired or was already used; request a new one.');
const unavailable = (err: AttestationUnavailable) =>
  new ApiError(503, 'attestation_unavailable', 'The attestation provider is unavailable; retry later.', undefined, {
    'Retry-After': String(err.retryAfterSeconds),
  });

/** المتحقق من Play Integrity حسب الوضع: واجهة Google في الإنتاج، والحكم غير الموقّع في الاختبار. */
export function playIntegrityDecoderFor(config: AppConfig): PlayIntegrityDecoder | null {
  if (config.ATTESTATION_MODE === 'off' || !config.PLAY_INTEGRITY_PACKAGE_NAME) return null;
  if (config.ATTESTATION_MODE === 'test') return new UnsignedTestDecoder();
  if (!config.PLAY_INTEGRITY_SERVICE_ACCOUNT) return null;
  return new GooglePlayIntegrityDecoder(config.PLAY_INTEGRITY_SERVICE_ACCOUNT, config.PLAY_INTEGRITY_PACKAGE_NAME);
}

/**
 * جانب الخادم من SEC-07 (ADR 0011): تحديات، وتسجيل مفاتيح App Attest، ورمز ingest لكل جلسة رفع بعد شهادة الجهاز.
 * `key_id` بيانات كاشفة (معرّف تثبيت): يُخزَّن ببصمته ولا يُسجَّل ولا يدخل التدقيق. التدقيق بالمعرّفات وحدها، وسبب
 * الرفض الداخلي في reason_code (لا يُعاد للعميل: 403 attestation_failed واحد).
 */
@Injectable()
export class DeviceAttestationService implements ReplayRehydrator {
  private readonly appAttest: AppAttestPolicy | null;
  private readonly signer: IngestTokenSigner | null;
  private readonly limiter: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PLAY_INTEGRITY_DECODER) private readonly play: PlayIntegrityDecoder | null,
    private readonly challenges: ChallengeStore,
    limits: RateLimitsService,
    private readonly sessions: SessionService,
  ) {
    const enabled = config.ATTESTATION_MODE !== 'off';
    this.appAttest =
      enabled && config.APP_ATTEST_APP_ID
        ? {
            appId: config.APP_ATTEST_APP_ID,
            allowDevelopment: config.APP_ATTEST_ALLOW_DEVELOPMENT,
            root: new X509Certificate(
              config.ATTESTATION_MODE === 'test' ? Buffer.from(config.APP_ATTEST_TEST_ROOT_PEM!, 'base64') : APPLE_APP_ATTEST_ROOT_PEM,
            ),
          }
        : null;
    this.signer = enabled ? new IngestTokenSigner(config.INGEST_TOKEN_SIGNING_KEY!, config.INGEST_TOKEN_KEY_ID!) : null;
    this.limiter = limits.create('attestation-user', config.ATTESTATION_RATE_LIMIT_MAX);
  }

  async challenge(p: Principal): Promise<AttestationChallenge> {
    this.assertEnabled();
    await this.limit(p.userId);
    const issued = await this.guard(() => this.challenges.issue(p.userId));
    return { challenge_id: issued.id, challenge: issued.challenge.toString('base64url'), expires_at: issued.expiresAt.toISOString() };
  }

  /** تسجيل مفتاح App Attest مرة لكل تثبيت. المفتاح المسجَّل لمستخدم آخر (أو المبطَل) 409 attestation_key_conflict. */
  async register(p: Principal, body: KeyRegistration): Promise<{ key_ref: string }> {
    this.assertEnabled();
    if (!this.appAttest) throw ApiError.notFound();
    const keyId = decodeBase64(body.key_id, '/key_id');
    const attestation = decodeBase64(body.attestation, '/attestation');
    const challenge = await this.guard(() => this.challenges.consume(body.challenge_id, p.userId));
    if (!challenge) throw expired();

    let publicKeySpki: Buffer;
    let environment: string;
    try {
      ({ publicKeySpki, environment } = verifyAttestation(attestation, keyId, challenge, this.appAttest));
    } catch (err) {
      if (!(err instanceof AttestationRejected)) throw err;
      await this.audit(this.db, p.userId, 'device_attestation.rejected', 'user', p.userId, { target_user_id: p.userId, reason_code: err.reason });
      throw failed();
    }

    const keyIdHash = sha256(keyId);
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(deviceAttestationKeys)
        .values({ userId: p.userId, platform: 'ios', keyIdHash, publicKey: publicKeySpki })
        .onConflictDoNothing({ target: deviceAttestationKeys.keyIdHash })
        .returning({ id: deviceAttestationKeys.id });
      if (!created) {
        const [existing] = await tx.select().from(deviceAttestationKeys).where(eq(deviceAttestationKeys.keyIdHash, keyIdHash));
        // التسجيل نفسه مكررًا للمستخدم نفسه يعيد المرجع نفسه؛ غيره تعارض (ولا يُحيا مفتاح مبطَل)
        if (existing && existing.userId === p.userId && !existing.revokedAt) return { key_ref: existing.id };
        throw new ApiError(409, 'attestation_key_conflict', 'This device key is registered to another account or revoked.');
      }
      await this.audit(tx, p.userId, 'device_attestation.registered', 'device_attestation_key', created.id, {
        target_user_id: p.userId,
        reason_code: environment,
      });
      return { key_ref: created.id };
    });
  }

  /** رمز ingest لجلسة رفع حية يملكها المستدعي، بعد تأكيد App Attest أو حكم Play Integrity على clientData. */
  async ingestToken(p: Principal, sessionId: string, body: IngestTokenRequest): Promise<IngestToken> {
    this.assertEnabled();
    const session = await this.liveSession(p, sessionId);
    await this.limit(p.userId);
    const challenge = await this.guard(() => this.challenges.consume(body.challenge_id, p.userId));
    if (!challenge) throw expired();
    // clientData = التحدي ‖ معرّف الجلسة: التأكيد لا يصلح لجلسة أخرى ولا يُعاد
    const clientData = Buffer.concat([challenge, Buffer.from(session.id)]);

    try {
      if (body.platform === 'ios') await this.assertIos(p, body, clientData);
      else await this.assertAndroid(body.integrity_token, clientData);
    } catch (err) {
      if (err instanceof AttestationUnavailable) throw unavailable(err);
      if (!(err instanceof AttestationRejected)) throw err;
      await this.audit(this.db, p.userId, 'ingest_token.rejected', 'upload_session', session.id, {
        upload_session_id: session.id,
        target_user_id: p.userId,
        reason_code: err.reason,
      });
      throw failed();
    }

    const minted = this.mint(session, body.platform);
    await this.audit(this.db, p.userId, 'ingest_token.issued', 'upload_session', session.id, {
      upload_session_id: session.id,
      target_user_id: p.userId,
      reason_code: body.platform,
    });
    return minted;
  }

  /**
   * رمز ingest لرفع الويب (بلا شهادة جهاز): يطلبه الـBFF وحده (يتحقق المتحكم من عنوانه) لجلسة رفع حية يملكها
   * المستدعي، بعمر ≤ 10 دقائق، مربوطًا بجلسة الرفع وبجلسة الدخول (ses) فيسقط بإبطال أيهما عند فحص البوابة.
   */
  async webIngestToken(p: Principal, authSessionId: string, sessionId: string): Promise<IngestToken> {
    if (!this.signer) throw ApiError.notFound();
    const session = await this.liveSession(p, sessionId);
    await this.limit(p.userId);
    const minted = this.mint(session, 'web', authSessionId);
    await this.audit(this.db, p.userId, 'ingest_token.issued', 'upload_session', session.id, {
      upload_session_id: session.id,
      target_user_id: p.userId,
      reason_code: 'web',
    });
    return minted;
  }

  /**
   * فحص البوابة قبل كل PATCH (GET /internal/ingest/session-status): الجلسة تقبل رفعًا الآن وصاحبها فاعل، وجلسة الدخول
   * (لرمز الويب) لم تُبطل. أي شيء آخر رفض، فيسقط الرفع خلال ثوانٍ من الإبطال لا عند انتهاء الرمز.
   */
  async sessionAccepts(sid: string, ses: string | undefined): Promise<boolean> {
    if (!UUID.test(sid) || (ses !== undefined && !UUID.test(ses))) return false;
    const [s] = await this.db.select().from(uploadSessions).where(eq(uploadSessions.id, sid));
    const now = new Date();
    if (
      !s ||
      !['created', 'in_progress'].includes(s.state) ||
      s.uploadPath !== 'tusd' ||
      !s.uploadTokenHash ||
      new Date(s.expiresAt) <= now ||
      (s.uploadTokenExpiresAt !== null && new Date(s.uploadTokenExpiresAt) <= now)
    ) {
      return false;
    }
    const [owner] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, s.createdBy));
    if (owner?.status !== 'active') return false;
    if (ses === undefined) return true;
    const head = await this.sessions.chainHead(this.db, ses);
    return Boolean(head && head.user_id === s.createdBy && head.revoked_at === null && new Date(head.expires_at) > now);
  }

  /**
   * إعادة الطلب بالمفتاح نفسه: الرد المحفوظ بلا الرمز (withoutTokens)، والتحدي استُهلك فلا يُعاد التحقق. يُصدر رمز جديد
   * للجلسة نفسها بانتهاء الأول نفسه لا أبعد، ما دامت الجلسة حية والمهلة لم تنقضِ؛ وإلا 409.
   */
  async rehydrate(stored: unknown, req: Request): Promise<unknown> {
    const { expires_at } = stored as { expires_at?: string };
    const sessionId = String(req.params.id ?? '');
    const session = await this.liveSession(req.principal!, sessionId);
    // رمز الويب يُعاد بجلسة الدخول نفسها؛ رمز الجهاز بمنصته
    if (req.path.endsWith('/web-ingest-token')) {
      if (!expires_at || new Date(expires_at) <= new Date()) {
        throw new ApiError(409, 'upload_state_conflict', 'The ingest token from this request has expired; request a new one.');
      }
      return this.mint({ ...session, expiresAt: new Date(Math.min(new Date(expires_at).getTime(), new Date(session.expiresAt).getTime())).toISOString() }, 'web', req.auth!.sessionId);
    }
    const plat = (req.body as { platform?: 'ios' | 'android' })?.platform ?? 'ios';
    if (!expires_at || new Date(expires_at) <= new Date()) {
      throw new ApiError(409, 'upload_state_conflict', 'The ingest token from this request has expired; request a new one.');
    }
    return this.mint({ ...session, expiresAt: new Date(Math.min(new Date(expires_at).getTime(), new Date(session.expiresAt).getTime())).toISOString() }, plat);
  }

  private async assertIos(p: Principal, body: Extract<IngestTokenRequest, { platform: 'ios' }>, clientData: Buffer): Promise<void> {
    if (!this.appAttest) throw new AttestationRejected('ios_not_configured');
    const keyIdHash = sha256(decodeBase64(body.key_id, '/key_id'));
    const assertion = decodeBase64(body.assertion, '/assertion');
    const [key] = await this.db
      .select()
      .from(deviceAttestationKeys)
      .where(and(eq(deviceAttestationKeys.keyIdHash, keyIdHash), eq(deviceAttestationKeys.userId, p.userId), isNull(deviceAttestationKeys.revokedAt)));
    if (!key) throw new AttestationRejected('unknown_key');
    const { signCount } = verifyAssertion(assertion, clientData, key.publicKey, this.appAttest.appId);
    // العدّاد يتزايد ذريًا: تأكيد مكرر أو أقدم (وإن صح توقيعه) إعادة تشغيل
    const [updated] = await this.db
      .update(deviceAttestationKeys)
      .set({ signCount, lastUsedAt: sql`now()` })
      .where(and(eq(deviceAttestationKeys.id, key.id), lt(deviceAttestationKeys.signCount, signCount), isNull(deviceAttestationKeys.revokedAt)))
      .returning({ id: deviceAttestationKeys.id });
    if (!updated) throw new ApiError(409, 'assertion_replay', 'This assertion was already used.');
  }

  private async assertAndroid(integrityToken: string, clientData: Buffer): Promise<void> {
    if (!this.play || !this.config.PLAY_INTEGRITY_PACKAGE_NAME) throw new AttestationRejected('android_not_configured');
    const payload = await this.play.decode(integrityToken);
    checkPlayVerdict(payload, {
      packageName: this.config.PLAY_INTEGRITY_PACKAGE_NAME,
      requestHash: sha256(clientData).toString('base64url'),
      certDigests: this.config.PLAY_INTEGRITY_CERT_SHA256,
    });
  }

  private mint(session: { id: string; expiresAt: string }, plat: 'ios' | 'android' | 'web', ses?: string): IngestToken {
    // رمز الويب ≤ 10 دقائق (لا شهادة جهاز خلفه)
    const ttl = plat === 'web' ? Math.min(this.config.INGEST_TOKEN_TTL_SECONDS, WEB_TOKEN_MAX_SECONDS) : this.config.INGEST_TOKEN_TTL_SECONDS;
    const expiresAt = new Date(Math.min(Date.now() + ttl * 1000, new Date(session.expiresAt).getTime()));
    const minted = this.signer!.mint({ sid: session.id, plat, ses, expiresAt });
    return { token: minted.token, expires_at: minted.expiresAt.toISOString() };
  }

  /** جلسة غيره أو غير موجودة 404؛ جلسة لا تقبل رفعًا (منتهية، مكتملة، مبطَل رمزها، أو مسار مباشر) 409. */
  private async liveSession(p: Principal, sessionId: string) {
    if (!UUID.test(sessionId)) throw ApiError.notFound();
    const [s] = await this.db.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId));
    if (!s || s.createdBy !== p.userId) throw ApiError.notFound();
    if (!['created', 'in_progress'].includes(s.state) || s.uploadPath !== 'tusd' || !s.uploadTokenHash || new Date(s.expiresAt) <= new Date()) {
      throw new ApiError(409, 'upload_state_conflict', 'This upload session no longer accepts uploads.');
    }
    return s;
  }

  private assertEnabled(): void {
    if (this.config.ATTESTATION_MODE === 'off') throw ApiError.notFound();
  }

  private async limit(userId: string): Promise<void> {
    const wait = await this.limiter.retryAfter(userId);
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
    await this.limiter.record(userId);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AttestationUnavailable) throw unavailable(err);
      throw err;
    }
  }

  private async audit(db: Executor, actorId: string, action: string, targetType: string, targetId: string, details: Record<string, string>): Promise<void> {
    await db.insert(auditLog).values({ actorId, action, targetType, targetId, details, hash: Buffer.alloc(32) });
  }
}

function decodeBase64(value: string, field: string): Buffer {
  if (!BASE64.test(value)) throw ApiError.validation({ fields: [field] });
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
