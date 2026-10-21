import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, count, eq, sql } from 'drizzle-orm';
import { base32Encode, constantTimeEqual, type FieldKeyring, randomToken, sha256, verifyTotp } from '../common/crypto';
import { pgError } from '../common/db-errors';
import type { Database, Tx } from '../database/database.module';
import { auditLog, offices, userRoles, users } from '../database/schema/schema';
import { AdminRecoveryError, type Approver, confirmTwoPeople } from './admin-recovery';
import type { RoleName } from './principal';
import { audit } from './recovery-approval';

// الدوران اللذان يؤكدان إجراء الشخصين يُسجَّل لهما TOTP عند الإنشاء، فلا مسار تسجيل لهما خارج الاستعادة
const TOTP_AT_CREATION: readonly RoleName[] = ['system_admin', 'editor_in_chief'];

export const ROLE_NAMES: readonly RoleName[] = ['system_admin', 'editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer'];

export interface NewUser {
  email: string;
  role: RoleName;
  scopeKind: 'all' | 'office' | 'governorate';
  scopeId: string;
  officeId?: string;
}

export type CreateUserInput = NewUser &
  (
    | { mode: 'one_admin'; approver: Approver }
    | { mode: 'two_admins'; approvers: [Approver, Approver] }
    | { mode: 'vault'; vaultToken: string; confirmer: Approver }
    | { mode: 'bootstrap'; vaultToken: string }
  );

/**
 * إنشاء حساب على مضيف حقيقي من سطر الأوامر (ADR 0024): لا مسار في الواجهة لإنشاء الحسابات. كلمة سر عشوائية تُعاد مرة
 * لتُطبع على الطرفية وحدها، ومخزنها argon2، ولمدير النظام ورئيس التحرير سرّ TOTP يُعاد معها مرة (otpauth). أي دور غير مدير النظام بمدير نظام فاعل واحد برمز TOTP (`one_admin`)؛ ومدير
 * النظام بإجراء الشخصين (`two_admins` أو `vault`)، أو بالخزنة وحدها (`bootstrap`) ما دام المديرون الفاعلون أقل من اثنين.
 * التدقيق `user.created` بالمعرّفات والدور والنطاق وطريق الاعتماد، بلا البريد.
 */
export async function createUser(
  db: Database,
  deps: { keyring: FieldKeyring; breakGlassTokenSha256?: string },
  input: CreateUserInput,
): Promise<{ userId: string; password: string; actorId: string | null; otpauthUri: string | null }> {
  validate(input);
  const password = randomToken(18);
  const passwordHash = await hash(password);
  const totpSecret = TOTP_AT_CREATION.includes(input.role) ? randomBytes(20) : null;
  const reasonCode = `cli_${input.mode}`;
  try {
    const outcome = await db.transaction(async (tx) => {
      // الاعتماد قبل أي كتابة؛ القفل الاستشاري يسلسل إنشاءات الإقلاع فلا يتجاوز اثنان معًا حد المديرين
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cli:create-user'))`);
      const actor = await authorize(tx, deps, input);
      if (actor === undefined) return { rejected: true as const };
      if (input.officeId) {
        const [o] = await tx.select({ id: offices.id }).from(offices).where(eq(offices.id, input.officeId));
        if (!o) throw new AdminRecoveryError('invalid_office', 'office not found');
      }
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          status: 'active',
          officeId: input.officeId ?? null,
          totpEnabled: totpSecret !== null,
          totpSecretEnc: totpSecret ? deps.keyring.encrypt(totpSecret) : null,
        })
        .returning({ id: users.id });
      await tx.insert(userRoles).values({ userId: u!.id, role: input.role, scopeKind: input.scopeKind, scopeId: input.scopeId, grantedBy: actor });
      await audit(tx, actor, 'user.created', u!.id, {
        target_user_id: u!.id,
        role: input.role,
        scope_kind: input.scopeKind,
        scope_id: input.scopeId,
        reason_code: reasonCode,
      });
      if (input.mode === 'two_admins' || input.mode === 'vault') {
        const second = input.mode === 'two_admins' ? input.approvers[1].userId : input.confirmer.userId;
        if (second !== actor) {
          await audit(tx, second, 'user.created_confirmed', u!.id, { target_user_id: u!.id, reason_code: reasonCode });
        }
      }
      return { rejected: false as const, userId: u!.id, actor };
    });
    if (outcome.rejected) {
      // لا حساب أُنشئ، فلا هدف للسطر؛ الرفض يُسجَّل بطريقه وحده
      await db.insert(auditLog).values({ actorId: null, action: 'user.create_cli_rejected', targetType: 'user', targetId: null, details: { reason_code: reasonCode }, hash: Buffer.alloc(32) });
      throw new AdminRecoveryError('verification_failed', 'verification failed');
    }
    // المعرّف لا البريد في otpauth (وصف العقد لتسجيل TOTP)
    const otpauthUri = totpSecret
      ? `otpauth://totp/${encodeURIComponent(`PostHistory:${outcome.userId}`)}?secret=${base32Encode(totpSecret)}&issuer=PostHistory&algorithm=SHA1&digits=6&period=30`
      : null;
    return { userId: outcome.userId, password, actorId: outcome.actor, otpauthUri };
  } catch (err) {
    if (pgError(err).constraint === 'users_email_lower_key') throw new AdminRecoveryError('email_taken', 'an account with this email exists');
    throw err;
  }
}

function validate(input: CreateUserInput): void {
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(input.email)) throw new AdminRecoveryError('invalid_input', 'a valid --email is required');
  if (!ROLE_NAMES.includes(input.role)) throw new AdminRecoveryError('invalid_input', `--role must be one of ${ROLE_NAMES.join(', ')}`);
  if ((input.scopeKind === 'all') !== (input.scopeId === '')) throw new AdminRecoveryError('invalid_input', '--scope-id is required with office or governorate scope, and only then');
  if (input.role === 'reporter' && !input.officeId) throw new AdminRecoveryError('invalid_input', 'a reporter needs --office');
  const admin = input.role === 'system_admin';
  if (admin && input.mode === 'one_admin') throw new AdminRecoveryError('invalid_input', 'a system administrator needs two people (two-admins or vault) or bootstrap');
  if (!admin && input.mode === 'bootstrap') throw new AdminRecoveryError('invalid_input', 'bootstrap creates system administrators only');
}

/** المعتمِد المسجَّل (أول المؤكِّدين، أو null للإقلاع)، أو undefined إن فشل التحقق من الرموز. */
async function authorize(tx: Tx, deps: { keyring: FieldKeyring; breakGlassTokenSha256?: string }, input: CreateUserInput): Promise<string | null | undefined> {
  switch (input.mode) {
    case 'one_admin':
      return (await confirmOneAdmin(tx, deps, input.approver)) ? input.approver.userId : undefined;
    case 'two_admins':
      return (await confirmTwoPeople(tx, deps, input, '')) ? input.approvers[0].userId : undefined;
    case 'vault':
      return (await confirmTwoPeople(tx, deps, input, '')) ? input.confirmer.userId : undefined;
    case 'bootstrap': {
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(eq(userRoles.role, 'system_admin'), eq(users.status, 'active')))) as [{ n: number }];
      if (n >= 2) throw new AdminRecoveryError('bootstrap_closed', 'two active system administrators exist; use two-admins or vault');
      if (!deps.breakGlassTokenSha256) throw new AdminRecoveryError('vault_disabled', 'BREAK_GLASS_TOKEN_SHA256 is not configured');
      return constantTimeEqual(sha256(input.vaultToken).toString('hex'), deps.breakGlassTokenSha256.toLowerCase()) ? null : undefined;
    }
  }
}

async function confirmOneAdmin(tx: Tx, deps: { keyring: FieldKeyring }, approver: Approver): Promise<boolean> {
  // تحقق confirmTwoPeople نفسه لشخص واحد بدور مدير النظام
  const [u] = await tx
    .select({ status: users.status, totpEnabled: users.totpEnabled, secret: users.totpSecretEnc })
    .from(users)
    .where(eq(users.id, approver.userId));
  const roles = u ? (await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, approver.userId))).map((r) => r.role) : [];
  if (!u || u.status !== 'active' || !roles.includes('system_admin')) {
    throw new AdminRecoveryError('invalid_approvers', `approver ${approver.userId} is not an active system_admin`);
  }
  return Boolean(u.totpEnabled && u.secret && verifyTotp(deps.keyring.decrypt(u.secret), approver.totp));
}
