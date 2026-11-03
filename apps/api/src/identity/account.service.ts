import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomInt, randomUUID } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { randomToken, sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { offices, recoveryCodes, recoveryRequests, refreshTokens, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { hasRole, isReporterAccount, mayDecideFor, type Principal, type RoleName, supervisesUser } from './principal';
import { CredentialAttempts } from './credential-attempts';
import { audit, recordRecoveryApproval, resetCredentials } from './recovery-approval';
import { RESET_TOKEN_DELIVERY, type ResetTokenDelivery } from './reset-token-delivery';
import type { RateLimiter } from './rate-limiter';
import { RateLimitsService } from './rate-limits.service';
import { SessionService } from './session.service';
import { recordStatusChange } from './user-status';

type UserSession = components['schemas']['UserSession'];
type RecoveryApproval = components['schemas']['RecoveryApproval'];
type PasswordResetLink = components['schemas']['PasswordResetLink'];
type PasswordResetReason = components['schemas']['PasswordResetReason'];

/** عشرة رموز احتياطية base32 بطول 12 (60 بت لكل رمز)؛ تكفي مع اعتماد المشرف وحد المعدل (ADR 0107). */
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 12;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** «أين أنا مسجَّل» وإبطال الجلسات عن بُعد (SEC-01)، واستعادة الحساب بالرمز الاحتياطي ثم اعتماد المشرف. */
@Injectable()
export class AccountService {
  private readonly recoveryByEmail: RateLimiter;
  private readonly recoveryByIp: RateLimiter;
  private readonly codesByUser: RateLimiter;
  private readonly resetLinksByActor: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    limits: RateLimitsService,
    @Inject(RESET_TOKEN_DELIVERY) private readonly resetTokens: ResetTokenDelivery,
    private readonly attempts: CredentialAttempts,
  ) {
    this.recoveryByEmail = limits.create('recovery-email', config.LOGIN_RATE_LIMIT_MAX);
    this.recoveryByIp = limits.create('recovery-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
    this.codesByUser = limits.create('recovery-codes-user', config.LOGIN_RATE_LIMIT_MAX);
    this.resetLinksByActor = limits.create('reset-link-actor', config.LOGIN_RATE_LIMIT_MAX);
  }

  /** اسم داخلي مستقل؛ لا يذهب إلى التدقيق ولا Outbox. قفل المستخدم يسلسل التعيين. */
  async setWorkName(p: Principal, userId: string, name: string | null): Promise<void> {
    if (!hasRole(p, 'system_admin')) throw new ApiError(403, 'forbidden_scope', 'Administrator required.');
    if (!UUID.test(userId)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [u] = await tx.select({ id: users.id, organizationId: users.organizationId, workName: users.workName })
        .from(users).where(eq(users.id, userId)).for('update');
      if (!u) throw ApiError.notFound();
      const roles = await rolesOf(tx, userId);
      if (u.organizationId || roles.some(r => ['reporter', 'buyer_admin', 'buyer_member'].includes(r)) || !roles.length) {
        throw ApiError.validation({ fields: ['/work_name'] });
      }
      if (u.workName === name) return;
      await tx.update(users).set({ workName: name }).where(eq(users.id, userId));
      await audit(tx, p.userId, 'user.work_name_changed', userId, {
        target_user_id: userId, reason_code: name === null ? 'work_name_cleared' : 'work_name_set',
      });
    });
  }

  // ---------- الجلسات ----------

  async listSessions(userId: string, currentSid: string): Promise<UserSession[]> {
    const current = await this.sessions.chainHead(this.db, currentSid);
    return (await this.sessions.listActive(userId)).map((s) => ({
      id: s.id,
      installation_id: s.installationId,
      platform: s.platform as UserSession['platform'],
      created_at: iso(s.createdAt)!,
      last_seen_at: iso(s.lastSeenAt),
      expires_at: iso(s.expiresAt)!,
      current: s.id === current?.id,
    }));
  }

  /**
   * المستخدم يبطل جلساته؛ مشرف نطاق صاحبها يبطلها بعد بلاغ فقد الهاتف لحساب مراسل وحده، ومدير النظام لأي حساب (ADR 0113)، ويُسجَّل في
   * التدقيق. ما ليس للمستدعي أن يبطله غير موجود بالنسبة إليه (404).
   */
  async revokeSession(p: Principal, sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [s] = await tx
        .select({ id: refreshTokens.id, userId: refreshTokens.userId, officeId: users.officeId, organizationId: users.organizationId, governorate: offices.governorate })
        .from(refreshTokens)
        .innerJoin(users, eq(users.id, refreshTokens.userId))
        .leftJoin(offices, eq(offices.id, users.officeId))
        .where(and(eq(refreshTokens.id, sessionId), isNull(refreshTokens.revokedAt)))
        .for('update', { of: refreshTokens });
      if (!s) throw ApiError.notFound();
      const own = s.userId === p.userId;
      if (!own && !hasRole(p, 'system_admin') && !(supervisesUser(p, s) && isReporterAccount(await rolesOf(tx, s.userId), s.organizationId))) {
        throw ApiError.notFound();
      }
      if (!own) await assertHierarchy(tx, p, s.userId);
      await tx.update(refreshTokens).set({ revokedAt: sql`now()` }).where(eq(refreshTokens.id, s.id));
      if (!own) {
        await audit(tx, p.userId, 'session.revoked', s.userId, { session_id: s.id, target_user_id: s.userId });
      }
    });
  }

  // ---------- الاستعادة ----------

  /**
   * الاستجابة نفسها لأي بريد ورمز (لا كشف لصحة الرموز). الرمز الصحيح غير المستعمل يُستهلك ويفتح طلبًا بانتظار
   * اعتماد مشرف النطاق، ولا يُبطل الجلسات القائمة (رمز مسرّب لا يكفي لإخراج المراسل من أجهزته).
   */
  async startRecovery(email: string, backupCode: string, ip: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const wait = Math.max(await this.recoveryByIp.retryAfter(ip), await this.recoveryByEmail.retryAfter(`${normalized}|${ip}`));
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
    // كل محاولة تُعد (لا فرق بين الصحيحة والخاطئة في الرد، فلا يُكشف ذلك بالعدّاد أيضًا)
    await Promise.all([this.recoveryByIp.record(ip), this.recoveryByEmail.record(`${normalized}|${ip}`)]);

    const codeHash = sha256(backupCode);
    await this.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ id: users.id, officeId: users.officeId })
        .from(users)
        .where(sql`lower(${users.email}) = ${normalized}`);
      if (!user) return;
      const [used] = await tx
        .update(recoveryCodes)
        .set({ usedAt: sql`now()` })
        .where(and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, codeHash), isNull(recoveryCodes.usedAt)))
        .returning({ userId: recoveryCodes.userId });
      if (!used) return;
      const [request] = await tx
        .insert(recoveryRequests)
        .values({
          userId: user.id,
          expiresAt: sql`now() + make_interval(secs => ${this.config.RECOVERY_REQUEST_TTL_SECONDS})` as never,
        })
        .returning({ id: recoveryRequests.id });
      await audit(tx, null, 'auth.recovery_requested', user.id, { recovery_request_id: request!.id, target_user_id: user.id });
      await writeOutboxEvent(tx, {
        type: 'auth.recovery_requested',
        aggregateType: 'user',
        aggregateId: user.id,
        idempotencyKey: `auth.recovery_requested:${request!.id}`,
        payload: { recovery_request_id: request!.id, ...(user.officeId ? { office_id: user.officeId } : {}) },
      });
    });
  }

  /**
   * اعتماد مشرف نطاق المراسل أو مدير النظام بعد التحقق خارج النظام: يبطل كل جلسات الحساب ورموز رفعه وأجهزة إشعاره،
   * ويصدر رمز إعادة التعيين (يُعاد هنا مرة واحدة ما لم تتولَّ قناة التسليم المحقونة إيصاله). حساب مدير نظام لا يُعتمد
   * من الواجهة أبدًا (403 admin_quorum_required: إجراء الشخصين من سطر الأوامر). الطلب المعتمد أو المرفوض أو المنتهي
   * = 409 recovery_state_conflict، فإعادة الاعتماد لا تعيد الرمز أبدًا (ولا Idempotency-Key على /auth/*).
   */
  async approveRecovery(p: Principal, id: string, verificationNote: string): Promise<RecoveryApproval> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const result = await this.db.transaction(async (tx) => {
      const [r] = await tx
        .select({
          id: recoveryRequests.id,
          userId: recoveryRequests.userId,
          state: recoveryRequests.state,
          createdAt: recoveryRequests.createdAt,
          expiresAt: recoveryRequests.expiresAt,
          officeId: users.officeId,
          organizationId: users.organizationId,
          governorate: offices.governorate,
        })
        .from(recoveryRequests)
        .innerJoin(users, eq(users.id, recoveryRequests.userId))
        .leftJoin(offices, eq(offices.id, users.officeId))
        .where(eq(recoveryRequests.id, id))
        .for('update', { of: recoveryRequests });
      if (!r) throw ApiError.notFound();
      const targetRoles = await rolesOf(tx, r.userId);
      // المشرف يعتمد استعادة حساب مراسل في نطاقه وحده؛ المشتري والطاقم بغير دور المراسل لمدير النظام (ADR 0113)
      if (!hasRole(p, 'system_admin') && !(supervisesUser(p, r) && isReporterAccount(targetRoles, r.organizationId))) throw ApiError.notFound();
      if (targetRoles.includes('system_admin')) throw adminQuorumRequired();
      await assertHierarchy(tx, p, r.userId);
      if (r.state === 'pending_approval' && new Date(r.expiresAt) <= new Date()) {
        // يُثبَّت الانتهاء ثم يُرفض الاعتماد خارج المعاملة (الرمي داخلها كان سيلغي هذا التحديث)
        await tx.update(recoveryRequests).set({ state: 'expired', decidedAt: sql`now()` }).where(eq(recoveryRequests.id, r.id));
        return 'expired' as const;
      }
      if (r.state !== 'pending_approval') throw new ApiError(409, 'recovery_state_conflict', `The recovery request is ${r.state}.`);
      return recordRecoveryApproval(tx, r, p.userId, verificationNote, this.config.RECOVERY_RESET_TOKEN_TTL_SECONDS);
    });
    if (result === 'expired') throw new ApiError(409, 'recovery_state_conflict', 'The recovery request has expired.');

    const { approved, resetToken } = result;
    const expiresAt = iso(approved.resetTokenExpiresAt)!;
    const deliveredElsewhere = await this.resetTokens.deliver({
      token: resetToken,
      expiresAt,
      targetUserId: approved.userId,
      recoveryRequestId: approved.id,
    });
    return {
      id: approved.id,
      state: 'approved',
      created_at: iso(approved.createdAt)!,
      approved_by: approved.approvedBy,
      expires_at: iso(approved.expiresAt),
      ...(deliveredElsewhere ? {} : { reset_token: resetToken }),
      reset_token_expires_at: expiresAt,
    };
  }

  // ---------- الرموز الاحتياطية (ADR 0107) ----------

  async recoveryCodeStatus(userId: string): Promise<components['schemas']['RecoveryCodeStatus']> {
    const [r] = await this.db
      .select({
        remaining: sql<number>`(count(*) FILTER (WHERE ${recoveryCodes.usedAt} IS NULL))::int`,
        generatedAt: sql<string | null>`max(${recoveryCodes.createdAt})`,
      })
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId));
    return { remaining: r?.remaining ?? 0, generated_at: iso(r?.generatedAt ?? null) };
  }

  /**
   * عشرة رموز جديدة تُعاد مرة واحدة وتُخزَّن ببصماتها، وكل رمز سابق للحساب يبطل في المعاملة نفسها. إعادة تحقق قبلها (كلمة المرور ثم
   * TOTP، ADR 0113) كما قبل تسجيل مفتاح المرور، فجلسة مسروقة وحدها لا تأخذ رموزًا ولا تبطل رموز صاحبها. كل توليد يُعد في حد المعدل لكل
   * حساب. التدقيق بالعدد وحده، والحدث بلا رمز ينبّه صاحب الحساب (رمز في يد غيره يبدأ استعادة تنتظر اعتماد المشرف، لا أكثر).
   */
  async generateRecoveryCodes(userId: string, stepUp: components['schemas']['PasskeyStepUp'] | undefined): Promise<components['schemas']['RecoveryCodes']> {
    const wait = await this.codesByUser.retryAfter(userId);
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
    await this.attempts.stepUp(userId, stepUp);
    await this.codesByUser.record(userId);
    const codes = new Set<string>();
    while (codes.size < RECOVERY_CODE_COUNT) codes.add(recoveryCode());
    const generatedAt = await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      const rows = await tx
        .insert(recoveryCodes)
        .values([...codes].map((code) => ({ userId, codeHash: sha256(code) })))
        .returning({ createdAt: recoveryCodes.createdAt });
      await audit(tx, userId, 'auth.recovery_codes_generated', userId, { target_user_id: userId, codes_count: String(codes.size) });
      await writeOutboxEvent(tx, {
        type: 'auth.recovery_codes_generated',
        aggregateType: 'user',
        aggregateId: userId,
        idempotencyKey: `auth.recovery_codes_generated:${randomUUID()}`,
        actorId: userId,
        payload: { codes_count: codes.size },
      });
      return rows[0]!.createdAt;
    });
    return { codes: [...codes], generated_at: iso(generatedAt)! };
  }

  // ---------- رابط إعادة التعيين من مدير النظام (A1، ADR 0107) ----------

  /**
   * لا مزوّد بريد: المدير يتحقق من الهوية خارج النظام ثم يصدر رمزًا لمرة واحدة قصير العمر يراه مرة ويسلّمه بيده. الرمز طلب استعادة
   * معتمد في recovery_requests، فيُكمل بـ /auth/recovery/complete ثم /auth/totp/confirm كأي استعادة. معاملة واحدة: كل طلب مفتوح
   * للحساب يُغلق (المنتظر يُرفض، والمعتمد غير المكتمل يبطل رمزه)، وأثر إعادة التعيين (resetCredentials)، والتدقيق بالسبب، وحدث
   * auth.recovery_approved بمعرّفات وحدها. لا يصدره المدير لحسابه ولا لحساب مدير نظام، والحساب غير الفاعل 409.
   */
  async issuePasswordResetLink(p: Principal, userId: string, reason: PasswordResetReason): Promise<PasswordResetLink> {
    if (!hasRole(p, 'system_admin')) throw new ApiError(403, 'forbidden_scope', 'Administrator required.');
    if (!UUID.test(userId)) throw ApiError.notFound();
    if (userId === p.userId) throw new ApiError(403, 'forbidden_scope', 'An administrator cannot issue a reset link for their own account.');
    const wait = await this.resetLinksByActor.retryAfter(p.userId);
    if (wait > 0) throw new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });

    const token = randomToken();
    const ttl = this.config.PASSWORD_RESET_LINK_TTL_SECONDS;
    const issued = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .select({ id: users.id, status: users.status, officeId: users.officeId })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!u) throw ApiError.notFound();
      if ((await rolesOf(tx, userId)).includes('system_admin')) throw adminQuorumRequired();
      if (u.status !== 'active') throw new ApiError(409, 'recovery_state_conflict', `The account is ${u.status}.`);
      await tx
        .update(recoveryRequests)
        .set({ state: 'rejected', decidedAt: sql`now()` })
        .where(and(eq(recoveryRequests.userId, userId), eq(recoveryRequests.state, 'pending_approval')));
      await tx
        .update(recoveryRequests)
        .set({ state: 'expired', resetTokenHash: null, resetTokenExpiresAt: null })
        .where(and(eq(recoveryRequests.userId, userId), eq(recoveryRequests.state, 'approved'), isNull(recoveryRequests.completedAt)));
      const [request] = await tx
        .insert(recoveryRequests)
        .values({
          userId,
          state: 'approved',
          approvedBy: p.userId,
          verificationNote: 'admin reset link',
          decidedAt: sql`now()`,
          expiresAt: sql`now() + make_interval(secs => ${ttl})` as never,
          resetTokenHash: sha256(token),
          resetTokenExpiresAt: sql`now() + make_interval(secs => ${ttl})` as never,
        })
        .returning({ id: recoveryRequests.id, expiresAt: recoveryRequests.resetTokenExpiresAt });
      const passkeysRevoked = await resetCredentials(tx, userId);
      await audit(tx, p.userId, 'auth.reset_link_issued', userId, {
        recovery_request_id: request!.id,
        target_user_id: userId,
        reason_code: reason,
        ...(passkeysRevoked ? { passkeys_revoked: String(passkeysRevoked) } : {}),
      });
      await writeOutboxEvent(tx, {
        type: 'auth.recovery_approved',
        aggregateType: 'user',
        aggregateId: userId,
        idempotencyKey: `auth.recovery_approved:${request!.id}`,
        actorId: p.userId,
        payload: { recovery_request_id: request!.id, ...(u.officeId ? { office_id: u.officeId } : {}) },
      });
      return { id: request!.id, expiresAt: iso(request!.expiresAt)! };
    });
    await this.resetLinksByActor.record(p.userId);
    const delivered = await this.resetTokens.deliver({ token, expiresAt: issued.expiresAt, targetUserId: userId, recoveryRequestId: issued.id });
    return { recovery_request_id: issued.id, ...(delivered ? {} : { reset_token: token }), reset_token_expires_at: issued.expiresAt };
  }

  // ---------- حالة الحساب ----------

  /**
   * تعليق حساب أو إعادة تفعيله (مدير النظام). التعليق يبطل كل وصول الحساب فورًا، وإعادة التفعيل لا تعيد شيئًا منه.
   * لا يغيّر المدير حالة حسابه، وحساب مدير نظام آخر لا يُمس من هنا في الاتجاهين (403 admin_quorum_required): تعليقه
   * يُنقص النصاب، وإعادة تفعيل مدير معلَّق بقرار شخص واحد تفتح الباب نفسه. ذاتي التكرار: الحالة القائمة = 204 بلا أثر.
   * التدقيق بـ reason_code وحده (لا نص حر، SEC-03)، وحدث user.status_changed بحمولة القائمة البيضاء.
   */
  async setUserStatus(p: Principal, userId: string, status: 'active' | 'suspended'): Promise<void> {
    if (!UUID.test(userId)) throw ApiError.notFound();
    if (userId === p.userId) throw new ApiError(403, 'forbidden_scope', 'An administrator cannot change the status of their own account.');
    await this.db.transaction(async (tx) => {
      const [u] = await tx.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, userId)).for('update');
      if (!u) throw ApiError.notFound();
      if ((await rolesOf(tx, userId)).includes('system_admin')) throw adminQuorumRequired();
      if (u.status === status) return;
      if (u.status !== 'active' && u.status !== 'suspended') {
        throw new ApiError(409, 'invalid_transition', `The account is in ${u.status}.`);
      }
      await recordStatusChange(tx, p.userId, userId, status);
    });
  }
}

/** رمز احتياطي: 12 حرفًا من أبجدية base32 باختيار منتظم لكل حرف. */
function recoveryCode(): string {
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) code += BASE32[randomInt(BASE32.length)];
  return code;
}

const adminQuorumRequired = () =>
  new ApiError(403, 'admin_quorum_required', 'A system administrator account is changed only by the two-person procedure.');

async function rolesOf(tx: Executor, userId: string): Promise<string[]> {
  return (await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.role);
}

/**
 * مطابقة النطاق وحدها لا تكفي: حساب دوره مساوٍ لدور المقرِّر أو أعلى لا يقرر فيه إلا مدير النظام، ولا يقرر أحد في حسابه
 * هو (وحساب مدير النظام نفسه خارج الواجهة كلها: admin_quorum_required). المورد ظاهر للمقرِّر بنطاقه، فالرفض 403 لا 404.
 */
async function assertHierarchy(tx: Executor, p: Principal, targetUserId: string): Promise<void> {
  const roles = await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, targetUserId));
  if (!mayDecideFor(p, targetUserId, roles.map((r) => r.role as RoleName))) {
    throw new ApiError(403, 'forbidden_scope', 'This account is not below the caller in rank; a system administrator must decide.');
  }
}
