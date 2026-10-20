/**
 * تعليق حساب مدير نظام أو إعادة تفعيله بتأكيد شخصين (identity/admin-status.ts)؛ الواجهة ترفض الاتجاهين لحساب مدير.
 *
 *   node dist/cli/set-admin-status.js --user <id> --status suspended|active --mode two-admins --approver <userId> --approver <userId>
 *   node dist/cli/set-admin-status.js --user <id> --status suspended|active --mode vault --approver <userId>
 *
 * رموز TOTP ورمز الخزنة تُقرأ من الطرفية وحدها كما في approve-admin-recovery، ولا تُطبع.
 */
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { fieldKeyring, loadConfig } from '../config/config';
import * as schema from '../database/schema/schema';
import { AdminRecoveryError, type Approver } from '../identity/admin-recovery';
import { type AdminStatusInput, setAdminStatus } from '../identity/admin-status';
import { lineReader } from './approve-admin-recovery';

export interface StatusCliArgs {
  userId: string;
  status: 'active' | 'suspended';
  mode: 'two_admins' | 'vault';
  approverIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseStatusCliArgs(argv: string[]): StatusCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      user: { type: 'string' },
      status: { type: 'string' },
      mode: { type: 'string' },
      approver: { type: 'string', multiple: true },
    },
    strict: true,
  });
  const mode = values.mode === 'two-admins' ? 'two_admins' : values.mode === 'vault' ? 'vault' : undefined;
  if (!mode) throw new Error('--mode must be two-admins or vault');
  if (!values.user || !UUID.test(values.user)) throw new Error('--user must be a user id');
  if (values.status !== 'active' && values.status !== 'suspended') throw new Error('--status must be active or suspended');
  const approverIds = values.approver ?? [];
  if (approverIds.length !== (mode === 'two_admins' ? 2 : 1) || !approverIds.every((id) => UUID.test(id))) {
    throw new Error(mode === 'two_admins' ? 'two --approver user ids are required' : 'one --approver user id (the confirming person) is required');
  }
  return { userId: values.user, status: values.status, mode, approverIds };
}

export async function main(argv: string[]): Promise<number> {
  let args: StatusCliArgs;
  try {
    args = parseStatusCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const config = loadConfig();
  const reader = lineReader();
  let input: AdminStatusInput;
  try {
    const approvers: Approver[] = [];
    for (const userId of args.approverIds) approvers.push({ userId, totp: await reader.ask(`TOTP code of ${userId}: `) });
    input =
      args.mode === 'two_admins'
        ? { mode: 'two_admins', userId: args.userId, status: args.status, approvers: [approvers[0]!, approvers[1]!] }
        : { mode: 'vault', userId: args.userId, status: args.status, vaultToken: await reader.ask('Vault break-glass token: '), confirmer: approvers[0]! };
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  } finally {
    reader.close();
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const done = await setAdminStatus(db, { keyring: fieldKeyring(config), breakGlassTokenSha256: config.BREAK_GLASS_TOKEN_SHA256 }, input);
    process.stdout.write(
      done.changed
        ? `${done.userId} is now ${done.status}${done.status === 'suspended' ? '; all sessions revoked' : ''}\n`
        : `${done.userId} was already ${done.status}; nothing changed\n`,
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
