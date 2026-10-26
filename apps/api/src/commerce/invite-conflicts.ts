import { asc, eq } from 'drizzle-orm';
import { type FieldKeyring, verifyTotp } from '../common/crypto';
import type { Database } from '../database/database.module';
import { buyerInviteConflicts, userRoles, users } from '../database/schema/schema';
import { audit } from '../identity/recovery-approval';

/**
 * طابور الدعوات المتعارضة لمدير النظام (متابعة أمن #304): دعوة مشترٍ ببريد حساب قائم خارج المؤسسة تُحفظ هنا بدل أن ترد
 * 409 تكشف البريد. المدير يراها ويحسمها من سطر الأوامر (cli/buyer-invite-conflicts)، فتخرج من قائمة أعضاء المؤسسة ومقاعدها.
 */
export interface PendingInviteConflict {
  id: string;
  organizationId: string;
  existingUserId: string;
  role: string;
  state: string;
  createdAt: string;
}

export class InviteConflictError extends Error {
  constructor(
    readonly code: 'not_found' | 'already_resolved' | 'invalid_admin' | 'totp_failed',
    message: string,
  ) {
    super(message);
  }
}

export async function openInviteConflicts(db: Database): Promise<PendingInviteConflict[]> {
  return db
    .select({
      id: buyerInviteConflicts.id,
      organizationId: buyerInviteConflicts.organizationId,
      existingUserId: buyerInviteConflicts.existingUserId,
      role: buyerInviteConflicts.role,
      state: buyerInviteConflicts.state,
      createdAt: buyerInviteConflicts.createdAt,
    })
    .from(buyerInviteConflicts)
    .where(eq(buyerInviteConflicts.state, 'pending'))
    .orderBy(asc(buyerInviteConflicts.createdAt), asc(buyerInviteConflicts.id));
}

export type ConflictRow = typeof buyerInviteConflicts.$inferSelect;

/**
 * الحسم بالحالة وحدها (العقد #361): مدير نظام فاعل برمز TOTP صحيح. `suspended` يعلّق العضو المدعو البديل، و`dismissed`
 * يغلقه نهائيًا ويحرر مقعده. من `pending` إلى الحالتين، ومن `suspended` إلى `dismissed`، وغيرها `invalid_transition`.
 * لا ملاحظة نصية، والتدقيق `buyer_member.invite_conflict_resolved` بـ `conflict_id` بلا البريد.
 */
export async function resolveInviteConflict(
  db: Database,
  deps: { keyring: FieldKeyring },
  input: { conflictId: string; adminId: string; totp: string; to: 'suspended' | 'dismissed' },
): Promise<ConflictRow> {
  return db.transaction(async (tx) => {
    const [admin] = await tx
      .select({ status: users.status, totpEnabled: users.totpEnabled, secret: users.totpSecretEnc })
      .from(users)
      .where(eq(users.id, input.adminId));
    const roles = admin ? (await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, input.adminId))).map((r) => r.role) : [];
    if (!admin || admin.status !== 'active' || !roles.includes('system_admin')) {
      throw new InviteConflictError('invalid_admin', `${input.adminId} is not an active system administrator`);
    }
    if (!admin.totpEnabled || !admin.secret || !verifyTotp(deps.keyring.decrypt(admin.secret), input.totp)) {
      throw new InviteConflictError('totp_failed', 'the two-factor code is not valid');
    }
    const [c] = await tx.select().from(buyerInviteConflicts).where(eq(buyerInviteConflicts.id, input.conflictId)).for('update');
    if (!c) throw new InviteConflictError('not_found', 'invite conflict not found');
    const allowed = c.state === 'pending' || (c.state === 'suspended' && input.to === 'dismissed');
    if (!allowed) throw new InviteConflictError('already_resolved', `invite conflict cannot go from ${c.state} to ${input.to}`);
    const now = new Date().toISOString();
    const [after] = await tx
      .update(buyerInviteConflicts)
      .set(input.to === 'dismissed' ? { state: 'dismissed', resolvedAt: now, resolvedBy: input.adminId, updatedAt: now } : { state: 'suspended', updatedAt: now })
      .where(eq(buyerInviteConflicts.id, c.id))
      .returning();
    await audit(tx, input.adminId, 'buyer_member.invite_conflict_resolved', c.existingUserId, {
      organization_id: c.organizationId,
      target_user_id: c.existingUserId,
      conflict_id: c.id,
      role: c.role,
      to: input.to,
    });
    return after!;
  });
}

/** الحسم من سطر الأوامر: الصرف النهائي. */
export async function dismissInviteConflict(
  db: Database,
  deps: { keyring: FieldKeyring },
  input: { conflictId: string; adminId: string; totp: string },
): Promise<void> {
  await resolveInviteConflict(db, deps, { ...input, to: 'dismissed' });
}
