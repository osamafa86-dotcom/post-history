import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { offices, recoveryCodes, recoveryRequests, refreshTokens, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { hasRole, mayDecideFor, type Principal, type RoleName, supervisesUser } from './principal';
import { audit, recordRecoveryApproval } from './recovery-approval';
import { RESET_TOKEN_DELIVERY, type ResetTokenDelivery } from './reset-token-delivery';
import type { RateLimiter } from './rate-limiter';
import { RateLimitsService } from './rate-limits.service';
import { revokeAllAccess, SessionService } from './session.service';

type UserSession = components['schemas']['UserSession'];
type RecoveryApproval = components['schemas']['RecoveryApproval'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** «أين أنا مسجَّل» وإبطال الجلسات عن بُعد (SEC-01)، واستعادة الحساب بالرمز الاحتياطي ثم اعتماد المشرف. */
@Injectable()
export class AccountService {
  private readonly recoveryByEmail: RateLimiter;
  private readonly recoveryByIp: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
    limits: RateLimitsService,
    @Inject(RESET_TOKEN_DELIVERY) private readonly resetTokens: ResetTokenDelivery,
  ) {
    this.recoveryByEmail = limits.create('recovery-email', config.LOGIN_RATE_LIMIT_MAX);
    this.recoveryByIp = limits.create('recovery-ip', config.LOGIN_RATE_LIMIT_IP_MAX);
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
   * المستخدم يبطل جلساته؛ مشرف نطاق صاحبها أو مدير النظام يبطلها بعد بلاغ فقد الهاتف ويُسجَّل في التدقيق.
   * ما ليس للمستدعي أن يبطله غير موجود بالنسبة إليه (404).
   */
  async revokeSession(p: Principal, sessionId: string): Promise<void> {
    if (!UUID.test(sessionId)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [s] = await tx
        .select({ id: refreshTokens.id, userId: refreshTokens.userId, officeId: users.officeId, governorate: offices.governorate })
        .from(refreshTokens)
        .innerJoin(users, eq(users.id, refreshTokens.userId))
        .leftJoin(offices, eq(offices.id, users.officeId))
        .where(and(eq(refreshTokens.id, sessionId), isNull(refreshTokens.revokedAt)))
        .for('update', { of: refreshTokens });
      if (!s) throw ApiError.notFound();
      const own = s.userId === p.userId;
      if (!own && !hasRole(p, 'system_admin') && !supervisesUser(p, s)) throw ApiError.notFound();
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
   * = 409 recovery_state_conflict؛ تكرار الطلب نفسه بمفتاح منع التكرار يعيد الاستجابة الأولى بلا الرمز.
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
          governorate: offices.governorate,
        })
        .from(recoveryRequests)
        .innerJoin(users, eq(users.id, recoveryRequests.userId))
        .leftJoin(offices, eq(offices.id, users.officeId))
        .where(eq(recoveryRequests.id, id))
        .for('update', { of: recoveryRequests });
      if (!r || (!hasRole(p, 'system_admin') && !supervisesUser(p, r))) throw ApiError.notFound();
      if ((await rolesOf(tx, r.userId)).includes('system_admin')) throw adminQuorumRequired();
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

  // ---------- حالة الحساب ----------

  /**
   * تعليق حساب أو إعادة تفعيله (مدير النظام). التعليق يبطل كل وصول الحساب فورًا، وإعادة التفعيل لا تعيد شيئًا منه.
   * لا يغيّر المدير حالة حسابه، وحساب مدير نظام آخر لا يُمس من هنا في الاتجاهين (403 admin_quorum_required): تعليقه
   * يُنقص النصاب، وإعادة تفعيل مدير معلَّق بقرار شخص واحد تفتح الباب نفسه. ذاتي التكرار: الحالة القائمة = 204 بلا أثر.
   * التدقيق بـ reason_code وحده (لا نص حر، SEC-03). لا حدث Outbox: لا نوع له في العقد.
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
      await tx.update(users).set({ status }).where(eq(users.id, userId));
      if (status === 'suspended') await revokeAllAccess(tx, userId);
      const reasonCode = status === 'suspended' ? 'suspended' : 'reactivated';
      await audit(tx, p.userId, `user.${reasonCode}`, userId, { target_user_id: userId, reason_code: reasonCode });
    });
  }
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
