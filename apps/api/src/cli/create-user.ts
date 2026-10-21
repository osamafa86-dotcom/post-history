/**
 * إنشاء حساب على مضيف حقيقي (identity/create-user.ts، ADR 0030).
 *
 *   node dist/cli/create-user.js --email <e> --role <role> [--scope-kind all|office|governorate --scope-id <id>] [--office <officeId>]
 *        --mode one-admin --approver <adminId>                 أي دور غير مدير النظام
 *        --mode two-admins --approver <adminId> --approver <adminId>   مدير نظام
 *        --mode vault --approver <adminOrChiefId>              مدير نظام (رمز الخزنة + شخص ثانٍ)
 *        --mode bootstrap                                      مدير نظام ما دام المديرون الفاعلون أقل من اثنين (رمز الخزنة)
 *
 * رموز TOTP ورمز الخزنة تُقرأ من الطرفية وحدها ولا تُطبع. كلمة السر الأولى تُطبع مرة على الطرفية (stdout) ولا تدخل سجلًا.
 */
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { fieldKeyring, loadConfig } from '../config/config';
import * as schema from '../database/schema/schema';
import { AdminRecoveryError, type Approver } from '../identity/admin-recovery';
import { type CreateUserInput, createUser, type NewUser } from '../identity/create-user';
import type { RoleName } from '../identity/principal';
import { lineReader } from './approve-admin-recovery';

export interface CreateUserCliArgs extends NewUser {
  mode: CreateUserInput['mode'];
  approverIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = { 'one-admin': 'one_admin', 'two-admins': 'two_admins', vault: 'vault', bootstrap: 'bootstrap' } as const;
const APPROVERS = { one_admin: 1, two_admins: 2, vault: 1, bootstrap: 0 } as const;

export function parseCreateUserCliArgs(argv: string[]): CreateUserCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      'scope-kind': { type: 'string' },
      'scope-id': { type: 'string' },
      office: { type: 'string' },
      mode: { type: 'string' },
      approver: { type: 'string', multiple: true },
    },
    strict: true,
  });
  const mode = MODES[values.mode as keyof typeof MODES];
  if (!mode) throw new Error('--mode must be one-admin, two-admins, vault or bootstrap');
  if (!values.email) throw new Error('--email is required');
  if (!values.role) throw new Error('--role is required');
  const scopeKind = (values['scope-kind'] ?? 'all') as NewUser['scopeKind'];
  if (!['all', 'office', 'governorate'].includes(scopeKind)) throw new Error('--scope-kind must be all, office or governorate');
  if (values.office !== undefined && !UUID.test(values.office)) throw new Error('--office must be an office id');
  const approverIds = values.approver ?? [];
  if (approverIds.length !== APPROVERS[mode] || !approverIds.every((id) => UUID.test(id))) {
    throw new Error(`--mode ${values.mode} takes ${APPROVERS[mode]} --approver user id(s)`);
  }
  return {
    email: values.email,
    role: values.role as RoleName,
    scopeKind,
    scopeId: values['scope-id'] ?? '',
    ...(values.office ? { officeId: values.office } : {}),
    mode,
    approverIds,
  };
}

export async function main(argv: string[]): Promise<number> {
  let args: CreateUserCliArgs;
  try {
    args = parseCreateUserCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const config = loadConfig();
  const reader = lineReader();
  let input: CreateUserInput;
  try {
    const approvers: Approver[] = [];
    for (const userId of args.approverIds) approvers.push({ userId, totp: await reader.ask(`TOTP code of ${userId}: `) });
    const { mode: _m, approverIds: _a, ...user } = args;
    input =
      args.mode === 'one_admin'
        ? { ...user, mode: 'one_admin', approver: approvers[0]! }
        : args.mode === 'two_admins'
          ? { ...user, mode: 'two_admins', approvers: [approvers[0]!, approvers[1]!] }
          : args.mode === 'vault'
            ? { ...user, mode: 'vault', vaultToken: await reader.ask('Vault break-glass token: '), confirmer: approvers[0]! }
            : { ...user, mode: 'bootstrap', vaultToken: await reader.ask('Vault break-glass token: ') };
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  } finally {
    reader.close();
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const done = await createUser(db, { keyring: fieldKeyring(config), breakGlassTokenSha256: config.BREAK_GLASS_TOKEN_SHA256 }, input);
    // تُطبع مرة هنا ولا تُخزَّن إلا مجزّأة؛ يسلّمها المشغّل للمستخدم بقناة آمنة
    process.stdout.write(
      `created ${done.userId} (${args.role})\none-time password: ${done.password}\n${done.otpauthUri ? `totp enrollment (scan once): ${done.otpauthUri}\n` : ''}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof AdminRecoveryError) {
      process.stderr.write(`refused (${err.code}): ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`failed: ${(err as Error)?.name ?? 'error'}\n`);
      process.exit(1);
    },
  );
}
