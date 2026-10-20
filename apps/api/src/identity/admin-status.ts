import { eq } from 'drizzle-orm';
import type { FieldKeyring } from '../common/crypto';
import { pgError } from '../common/db-errors';
import type { Database } from '../database/database.module';
import { userRoles, users } from '../database/schema/schema';
import { AdminRecoveryError, type Approver, confirmTwoPeople } from './admin-recovery';
import { audit } from './recovery-approval';
import { recordStatusChange } from './user-status';

export type AdminStatusInput =
  | { mode: 'two_admins'; userId: string; status: 'active' | 'suspended'; approvers: [Approver, Approver] }
  | { mode: 'vault'; userId: string; status: 'active' | 'suspended'; vaultToken: string; confirmer: Approver };

/**
 * تعليق حساب مدير نظام أو إعادة تفعيله من سطر الأوامر بتأكيد شخصين (الواجهة ترفض الاتجاهين: admin_quorum_required).
 * الوضعان كما في اعتماد استعادة المدير. الحالة القائمة = بلا أثر (unchanged). محفّز القاعدة يرفض تعليقًا ينزل بالمديرين
 * الفاعلين عن اثنين (quorum). المحاولة الفاشلة في الرموز تُسجَّل في التدقيق، والنجاح بطريقه (reason_code).
 */
export async function setAdminStatus(
  db: Database,
  deps: { keyring: FieldKeyring; breakGlassTokenSha256?: string },
  input: AdminStatusInput,
): Promise<{ userId: string; status: 'active' | 'suspended'; changed: boolean; actorId: string }> {
  const reasonCode = input.mode === 'two_admins' ? 'cli_two_admins' : 'cli_vault';
  const people = input.mode === 'two_admins' ? input.approvers : [input.confirmer];
  let outcome: { rejected: boolean; changed: boolean };
  try {
    outcome = await db.transaction(async (tx) => {
      const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.userId)).for('update');
      if (!u) throw new AdminRecoveryError('not_found', 'user not found');
      const roles = (await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, input.userId))).map((r) => r.role);
      if (!roles.includes('system_admin')) {
        throw new AdminRecoveryError('not_admin_target', 'only a system administrator account is changed here; use the API');
      }
      if (!(await confirmTwoPeople(tx, deps, input, input.userId))) return { rejected: true, changed: false };
      if (u.status === input.status) return { rejected: false, changed: false };
      if (u.status !== 'active' && u.status !== 'suspended') throw new AdminRecoveryError('not_pending', `the account is in ${u.status}`);
      await recordStatusChange(tx, people[0]!.userId, input.userId, input.status);
      await audit(tx, people[input.mode === 'two_admins' ? 1 : 0]!.userId, 'user.status_confirmed', input.userId, {
        target_user_id: input.userId,
        reason_code: reasonCode,
      });
      return { rejected: false, changed: true };
    });
  } catch (err) {
    // محفّز النصاب (admin_quorum_min_two): لا يُعلَّق مدير يترك أقل من مديرَين فاعلَين
    if (pgError(err).constraint === 'admin_quorum_min_two') {
      throw new AdminRecoveryError('quorum', 'suspending this administrator would leave fewer than two active administrators');
    }
    throw err;
  }
  if (outcome.rejected) {
    await db.transaction((tx) =>
      audit(tx, null, 'user.status_cli_rejected', input.userId, { target_user_id: input.userId, reason_code: reasonCode }),
    );
    throw new AdminRecoveryError('verification_failed', 'verification failed');
  }
  return { userId: input.userId, status: input.status, changed: outcome.changed, actorId: people[0]!.userId };
}
