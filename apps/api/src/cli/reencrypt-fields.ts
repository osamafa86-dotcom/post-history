/**
 * إعادة تشفير الحقول المشفرة بعد تدوير FIELD_ENCRYPTION_KEY (ADR 0005، التذكرة 8):
 *
 *   node dist/cli/reencrypt-fields.js [--dry-run] [--batch 500]
 *
 * يُشغَّل والبيئة فيها المفتاح الجديد حاليًا والقديم في *_PREVIOUS، ثم يُزال السابق حين يطبع stale = 0 لكل عمود
 * (بعد تشغيل ثانٍ بـ --dry-run). يطبع أعدادًا فقط، ويخرج بـ 1 إن فشل فك أي صف. لا يقفل الصفوف، فيُشغَّل والخادم يعمل.
 */
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { reencryptFields } from '../common/reencrypt';
import { fieldKeyring, loadConfig } from '../config/config';
import * as schema from '../database/schema/schema';

export function parseReencryptArgs(argv: string[]): { dryRun: boolean; batchSize: number } {
  const { values } = parseArgs({
    args: argv,
    options: { 'dry-run': { type: 'boolean' }, batch: { type: 'string' } },
    strict: true,
  });
  const batchSize = values.batch === undefined ? 500 : Number(values.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('--batch must be 1..10000');
  return { dryRun: values['dry-run'] ?? false, batchSize };
}

export async function main(argv: string[]): Promise<number> {
  let args: { dryRun: boolean; batchSize: number };
  try {
    args = parseReencryptArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 2;
  }
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const report = await reencryptFields(drizzle(pool, { schema }), fieldKeyring(config), args);
    process.stdout.write(`${JSON.stringify({ current_key_version: config.FIELD_ENCRYPTION_KEY_VERSION, dry_run: args.dryRun, columns: report })}\n`);
    return report.some((r) => r.failed > 0) ? 1 : 0;
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
