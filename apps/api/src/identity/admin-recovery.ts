import { eq } from 'drizzle-orm';
import { constantTimeEqual, type FieldKeyring, sha256, verifyTotp } from '../common/crypto';
import type { Database, Tx } from '../database/database.module';
import { offices, recoveryRequests, userRoles, users } from '../database/schema/schema';
import { audit, recordRecoveryApproval } from './recovery-approval';

export interface Approver {
  userId: string;
  totp: string;
}

export type AdminRecoveryInput =
  | { mode: 'two_admins'; requestId: string; note: string; approvers: [Approver, Approver] }
  | { mode: 'vault'; requestId: string; note: string; vaultToken: string; confirmer: Approver };

export class AdminRecoveryError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_pending' | 'not_admin_target' | 'invalid_approvers' | 'vault_disabled' | 'verification_failed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * مخرج الطوارئ (docs/ops/runbook.md): اعتماد استعادة حساب مدير نظام من سطر الأوامر حين لا يبقى مدير آخر يعتمدها من
 * الواجهة، بتأكيد شخصين دائمًا:
 * - two_admins: مديرا نظام آخران فاعلان، كلٌّ برمز TOTP من جهازه.
 * - vault: رمز التشغيل من الخزنة (يُقارن ببصمته BREAK_GLASS_TOKEN_SHA256، والرمز نفسه لا يُخزَّن) + تأكيد شخص ثانٍ
 *   فاعل (مدير نظام أو رئيس تحرير) برمز TOTP؛ هو المعتمِد المسجَّل.
 * كل محاولة فشلت في التحقق من الرموز تُسجَّل في التدقيق، والنجاح يُسجَّل بطريقه (reason_code).
 */
export async function approveAdminRecovery(
  db: Database,
  deps: { keyring: FieldKeyring; breakGlassTokenSha256?: string; resetTokenTtlSeconds: number },
  input: AdminRecoveryInput,
): Promise<{ requestId: string; targetUserId: string; approvedBy: string; resetToken: string; resetTokenExpiresAt: string }> {
  const reasonCode = input.mode === 'two_admins' ? 'cli_two_admins' : 'cli_vault';
  const outcome = await db.transaction(async (tx) => {
    const [r] = await tx
      .select({
        id: recoveryRequests.id,
        userId: recoveryRequests.userId,
        state: recoveryRequests.state,
        expiresAt: recoveryRequests.expiresAt,
        officeId: users.officeId,
        governorate: offices.governorate,
      })
      .from(recoveryRequests)
      .innerJoin(users, eq(users.id, recoveryRequests.userId))
      .leftJoin(offices, eq(offices.id, users.officeId))
      .where(eq(recoveryRequests.id, input.requestId))
      .for('update', { of: recoveryRequests });
    if (!r) throw new AdminRecoveryError('not_found', 'recovery request not found');
    if (r.state !== 'pending_approval' || new Date(r.expiresAt) <= new Date()) {
      throw new AdminRecoveryError('not_pending', `recovery request is ${r.state === 'pending_approval' ? 'expired' : r.state}`);
    }
    if (!(await rolesOf(tx, r.userId)).includes('system_admin')) {
      throw new AdminRecoveryError('not_admin_target', 'only a system administrator recovery is approved here; use the API');
    }

    const people = input.mode === 'two_admins' ? input.approvers : [input.confirmer];
    const allowed = input.mode === 'two_admins' ? ['system_admin'] : ['system_admin', 'editor_in_chief'];
    const ids = people.map((a) => a.userId);
    if (new Set(ids).size !== ids.length || ids.includes(r.userId)) {
      throw new AdminRecoveryError('invalid_approvers', 'approvers must be distinct people other than the account owner');
    }
    let verified = true;
    for (const person of people) {
      const [u] = await tx
        .select({ status: users.status, totpEnabled: users.totpEnabled, secret: users.totpSecretEnc })
        .from(users)
        .where(eq(users.id, person.userId));
      const roles = u ? await rolesOf(tx, person.userId) : [];
      if (!u || u.status !== 'active' || !roles.some((role) => allowed.includes(role))) {
        throw new AdminRecoveryError('invalid_approvers', `approver ${person.userId} is not an active ${allowed.join(' or ')}`);
      }
      // كل الرموز تُفحص قبل الحكم، فلا يُعرف أيها خاطئ
      if (!u.totpEnabled || !u.secret || !verifyTotp(deps.keyring.decrypt(u.secret), person.totp)) verified = false;
    }
    if (input.mode === 'vault') {
      if (!deps.breakGlassTokenSha256) throw new AdminRecoveryError('vault_disabled', 'BREAK_GLASS_TOKEN_SHA256 is not configured');
      if (!constantTimeEqual(sha256(input.vaultToken).toString('hex'), deps.breakGlassTokenSha256.toLowerCase())) verified = false;
    }
    if (!verified) return { rejected: true as const, targetUserId: r.userId };

    const { approved, resetToken } = await recordRecoveryApproval(tx, r, people[0]!.userId, input.note, deps.resetTokenTtlSeconds, reasonCode);
    if (input.mode === 'two_admins') {
      await audit(tx, people[1]!.userId, 'auth.recovery_confirmed', r.userId, {
        recovery_request_id: r.id,
        target_user_id: r.userId,
        reason_code: reasonCode,
      });
    }
    return {
      rejected: false as const,
      targetUserId: r.userId,
      approvedBy: people[0]!.userId,
      resetToken,
      resetTokenExpiresAt: approved.resetTokenExpiresAt!,
    };
  });

  if (outcome.rejected) {
    // يُسجَّل خارج المعاملة السابقة (لم يتغير فيها شيء) فيبقى أثر كل محاولة فاشلة
    await db.transaction((tx) =>
      audit(tx, null, 'auth.recovery_cli_rejected', outcome.targetUserId, {
        recovery_request_id: input.requestId,
        target_user_id: outcome.targetUserId,
        reason_code: reasonCode,
      }),
    );
    throw new AdminRecoveryError('verification_failed', 'verification failed');
  }
  return {
    requestId: input.requestId,
    targetUserId: outcome.targetUserId,
    approvedBy: outcome.approvedBy,
    resetToken: outcome.resetToken,
    resetTokenExpiresAt: new Date(outcome.resetTokenExpiresAt).toISOString(),
  };
}

async function rolesOf(tx: Tx, userId: string): Promise<string[]> {
  return (await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.role);
}

