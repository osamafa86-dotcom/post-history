import { sql } from 'drizzle-orm';
import type { Database } from '../database/database.module';
import type { FieldKeyring } from './crypto';

/** كل عمود مشفر على مستوى الحقل (`*_enc`) ومفتاح صفه. عمود جديد يُضاف هنا وإلا بقي بلا تدوير. */
export const ENCRYPTED_COLUMNS = [
  { table: 'users', key: 'id', column: 'totp_secret_enc' },
  { table: 'materials', key: 'id', column: 'gps_enc' },
  { table: 'push_devices', key: 'installation_id', column: 'token_enc' },
] as const;

export interface ReencryptCounts {
  table: string;
  column: string;
  stale: number;
  reencrypted: number;
  skipped: number;
  failed: number;
}

/**
 * يعيد تشفير كل حقل مكتوب بمفتاح غير الحالي (بايت الإصدار) إلى المفتاح الحالي، على دفعات بترتيب مفتاح الصف. قابل
 * للاستئناف بلا حالة: كل صف يُثبَّت وحده، وإعادة التشغيل لا ترى إلا ما بقي قديمًا. الصف الذي لا يُفك (مفتاحه ليس في
 * الحلقة) يُعد فاشلًا ويُتجاوز. dryRun يعد القديم فقط. لا يطبع قيمًا ولا مفاتيح صفوف.
 */
export async function reencryptFields(
  db: Database,
  keyring: FieldKeyring,
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<ReencryptCounts[]> {
  const batchSize = opts.batchSize ?? 500;
  const version = keyring.currentVersion;
  const report: ReencryptCounts[] = [];
  for (const { table, key, column } of ENCRYPTED_COLUMNS) {
    const t = sql.identifier(table);
    const k = sql.identifier(key);
    const c = sql.identifier(column);
    const stale = sql`${c} IS NOT NULL AND get_byte(${c}, 0) <> ${version}`;
    const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${t} WHERE ${stale}`);
    const counts: ReencryptCounts = { table, column, stale: rows[0]!.n, reencrypted: 0, skipped: 0, failed: 0 };
    report.push(counts);
    if (opts.dryRun || counts.stale === 0) continue;

    // بلا أقفال على الصفوف (الخادم يعمل أثناءها): كل تحديث مشروط بأن القيمة لم تتغير منذ القراءة، وما تغيّر بينهما
    // يُعد skipped ويلتقطه تشغيل لاحق إن بقي قديمًا
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const { rows: page } = await db.execute<{ k: string; v: Buffer }>(
        sql`SELECT ${k}::text AS k, ${c} AS v FROM ${t} WHERE ${stale} AND ${k} > ${after}::uuid ORDER BY ${k} LIMIT ${batchSize}`,
      );
      for (const row of page) {
        let next: Buffer;
        try {
          next = keyring.encrypt(keyring.decrypt(row.v));
        } catch {
          counts.failed++;
          continue;
        }
        const done = await db.execute(sql`UPDATE ${t} SET ${c} = ${next} WHERE ${k} = ${row.k}::uuid AND ${c} = ${row.v}`);
        if (done.rowCount) counts.reencrypted++;
        else counts.skipped++;
      }
      if (page.length < batchSize) break;
      after = page[page.length - 1]!.k;
    }
  }
  return report;
}
