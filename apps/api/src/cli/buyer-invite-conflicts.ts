/**
 * طابور الدعوات المتعارضة (commerce/invite-conflicts.ts، متابعة أمن #304).
 *
 *   node dist/cli/buyer-invite-conflicts.js list
 *   node dist/cli/buyer-invite-conflicts.js dismiss --id <conflictId> --admin <systemAdminId>
 *
 * القائمة بالمعرّفات وحدها بلا بريد. رمز TOTP يُقرأ من الطرفية ولا يُطبع.
 */
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { dismissInviteConflict, InviteConflictError, openInviteConflicts } from '../commerce/invite-conflicts';
import { fieldKeyring, loadConfig } from '../config/config';
import * as schema from '../database/schema/schema';
import { lineReader } from './approve-admin-recovery';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInviteConflictArgs(argv: string[]): { command: 'list' } | { command: 'dismiss'; conflictId: string; adminId: string } {
  const { values, positionals } = parseArgs({ args: argv, options: { id: { type: 'string' }, admin: { type: 'string' } }, strict: true, allowPositionals: true });
  if (positionals[0] === 'list' && positionals.length === 1) return { command: 'list' };
  if (positionals[0] === 'dismiss' && positionals.length === 1) {
    if (!values.id || !UUID.test(values.id)) throw new Error('--id must be an invite conflict id');
    if (!values.admin || !UUID.test(values.admin)) throw new Error('--admin must be a system administrator user id');
    return { command: 'dismiss', conflictId: values.id, adminId: values.admin };
  }
  throw new Error('usage: buyer-invite-conflicts list | dismiss --id <conflictId> --admin <adminId>');
}

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseInviteConflictArgs>;
  try {
    args = parseInviteConflictArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const config = loadConfig();
  let totp = '';
  if (args.command === 'dismiss') {
    const reader = lineReader();
    try {
      totp = await reader.ask(`TOTP code of ${args.adminId}: `);
    } finally {
      reader.close();
    }
  }
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    if (args.command === 'list') {
      for (const c of await openInviteConflicts(db)) {
        process.stdout.write(`${c.id} organization=${c.organizationId} existing_user=${c.existingUserId} role=${c.role} since=${c.createdAt}\n`);
      }
      return 0;
    }
    await dismissInviteConflict(db, { keyring: fieldKeyring(config) }, { conflictId: args.conflictId, adminId: args.adminId, totp });
    process.stdout.write(`dismissed ${args.conflictId}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InviteConflictError) {
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
