/**
 * مخرج الطوارئ: اعتماد استعادة حساب مدير نظام بتأكيد شخصين (identity/admin-recovery.ts، docs/ops/runbook.md).
 *
 *   node dist/cli/approve-admin-recovery.js --request <id> --mode two-admins --approver <userId> --approver <userId> --note "<كيف تُحقق منه>"
 *   node dist/cli/approve-admin-recovery.js --request <id> --mode vault --approver <userId> --note "<كيف تُحقق منه>"
 *
 * رموز TOTP ورمز الخزنة تُقرأ من الطرفية وحدها (لا من الوسائط، فلا تبقى في سجل الأوامر أو قائمة العمليات)، ولا تُطبع.
 * عند النجاح يُطبع رمز إعادة التعيين مرة واحدة على stdout ليسلّمه المعتمِد لصاحب الحساب خارج النظام (v0.1)؛ لا يُخزَّن إلا
 * ببصمته ولا يُعاد طبعه، فلا يُوجَّه stdout إلى ملف أو سجل.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { fieldKeyring, loadConfig } from '../config/config';
import * as schema from '../database/schema/schema';
import { AdminRecoveryError, type AdminRecoveryInput, type Approver, approveAdminRecovery } from '../identity/admin-recovery';

export interface CliArgs {
  requestId: string;
  mode: 'two_admins' | 'vault';
  approverIds: string[];
  note: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      request: { type: 'string' },
      mode: { type: 'string' },
      approver: { type: 'string', multiple: true },
      note: { type: 'string' },
    },
    strict: true,
  });
  const mode = values.mode === 'two-admins' ? 'two_admins' : values.mode === 'vault' ? 'vault' : undefined;
  if (!mode) throw new Error('--mode must be two-admins or vault');
  if (!values.request || !UUID.test(values.request)) throw new Error('--request must be a recovery request id');
  const approverIds = values.approver ?? [];
  if (approverIds.length !== (mode === 'two_admins' ? 2 : 1) || !approverIds.every((id) => UUID.test(id))) {
    throw new Error(mode === 'two_admins' ? 'two --approver user ids are required' : 'one --approver user id (the confirming person) is required');
  }
  const note = values.note?.trim();
  if (!note) throw new Error('--note is required: how the account owner was verified out of band');
  return { requestId: values.request, mode, approverIds, note };
}

/**
 * قارئ أسطر واحد للعملية كلها (واجهة readline لكل سؤال تبتلع ما بعد السطر الأول حين تأتي المدخلات دفعة واحدة)،
 * بلا صدى للرموز. انتهاء المدخلات قبل الجواب خطأ لا خروج صامت.
 */
function lineReader(): { ask(prompt: string): Promise<string>; close(): void } {
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: process.stdin.isTTY ?? false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(prompt: string) {
      process.stderr.write(prompt);
      const next = await lines.next();
      process.stderr.write('\n');
      if (next.done) throw new Error('input ended before every code was entered');
      return String(next.value).trim();
    },
    close: () => rl.close(),
  };
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const config = loadConfig();
  const reader = lineReader();
  let input: AdminRecoveryInput;
  try {
    const approvers: Approver[] = [];
    for (const userId of args.approverIds) approvers.push({ userId, totp: await reader.ask(`TOTP code of ${userId}: `) });
    input =
      args.mode === 'two_admins'
        ? { mode: 'two_admins', requestId: args.requestId, note: args.note, approvers: [approvers[0]!, approvers[1]!] }
        : { mode: 'vault', requestId: args.requestId, note: args.note, vaultToken: await reader.ask('Vault break-glass token: '), confirmer: approvers[0]! };
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  } finally {
    reader.close();
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const db = drizzle(pool, { schema });
    const done = await approveAdminRecovery(db, {
        keyring: fieldKeyring(config),
        breakGlassTokenSha256: config.BREAK_GLASS_TOKEN_SHA256,
        resetTokenTtlSeconds: config.RECOVERY_RESET_TOKEN_TTL_SECONDS,
      }, input);
    process.stdout.write(`approved recovery ${done.requestId}; all sessions of ${done.targetUserId} revoked\n`);
    process.stdout.write(`reset token (shown once, valid until ${done.resetTokenExpiresAt}): ${done.resetToken}\n`);
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
