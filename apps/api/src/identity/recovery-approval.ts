import { eq, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.module';
import { randomToken, sha256 } from '../common/crypto';
import { auditLog, recoveryRequests, users } from '../database/schema/schema';
import { writeOutboxEvent } from '../outbox/outbox';
import { revokeAllAccess } from './session.service';

type RecoveryRow = typeof recoveryRequests.$inferSelect;

/**
 * يطبّق اعتماد طلب استعادة مقفول بانتظار الاعتماد داخل المعاملة: الحالة، إبطال كل وصول الحساب، رمز إعادة التعيين
 * ووضع الحساب في «إعادة تعيين إلزامية» (v0.1)، التدقيق، وحدث auth.recovery_approved. يستدعيه مسار الواجهة
 * (AccountService) وأمر CLI الطوارئ؛ كلٌّ يتحقق من صلاحية المعتمِد قبله.
 * `reasonCode` يسمّي طريق الاعتماد في التدقيق (قائمة بيضاء من المفاتيح، لا نص حر).
 *
 * الرمز يُعاد للمستدعي وحده مرة واحدة ويُخزَّن ببصمته؛ لا يدخل التدقيق ولا الحدث ولا أي سجل (التدقيق يسجل الإصدار
 * بـ reason_code لا القيمة).
 */
export async function recordRecoveryApproval(
  tx: Tx,
  request: { id: string; userId: string; officeId: string | null },
  approverId: string,
  verificationNote: string,
  resetTokenTtlSeconds: number,
  reasonCode?: string,
): Promise<{ approved: RecoveryRow; resetToken: string }> {
  const resetToken = randomToken();
  const [approved] = await tx
    .update(recoveryRequests)
    .set({
      state: 'approved',
      approvedBy: approverId,
      verificationNote,
      decidedAt: sql`now()`,
      resetTokenHash: sha256(resetToken),
      resetTokenExpiresAt: sql`now() + make_interval(secs => ${resetTokenTtlSeconds})` as never,
    })
    .where(eq(recoveryRequests.id, request.id))
    .returning();
  await revokeAllAccess(tx, request.userId);
  // سر TOTP المعلّق من استعادة سابقة لم تكتمل لا يبقى: كل اعتماد يبدأ الدورة من أولها
  await tx.update(users).set({ credentialResetRequired: true, totpPendingSecretEnc: null }).where(eq(users.id, request.userId));
  await audit(tx, approverId, 'auth.recovery_approved', request.userId, {
    recovery_request_id: request.id,
    target_user_id: request.userId,
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  });
  await audit(tx, approverId, 'auth.reset_token_issued', request.userId, {
    recovery_request_id: request.id,
    target_user_id: request.userId,
    reason_code: 'reset_token_issued',
  });
  await writeOutboxEvent(tx, {
    type: 'auth.recovery_approved',
    aggregateType: 'user',
    aggregateId: request.userId,
    idempotencyKey: `auth.recovery_approved:${request.id}`,
    actorId: approverId,
    payload: { recovery_request_id: request.id, ...(request.officeId ? { office_id: request.officeId } : {}) },
  });
  return { approved: approved!, resetToken };
}

/** سجل التدقيق: مفاتيح القائمة البيضاء فقط (audit_details_allowed_keys)، والتجزئة يحسبها المحفّز. */
export async function audit(
  tx: Executor,
  actorId: string | null,
  action: string,
  targetUserId: string,
  details: Record<string, string>,
): Promise<void> {
  await tx.insert(auditLog).values({ actorId, action, targetType: 'user', targetId: targetUserId, details, hash: Buffer.alloc(32) });
}
