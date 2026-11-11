import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Database } from '../database/database.module';
import { idempotencyKeys } from '../database/schema/schema';

/**
 * مفتاح منع التكرار للطلب الجاري تنفيذه (ADR 0005، تعديل 2026-11-11). المعترض يفتحه حول المعالج وحده:
 * - `open`: المعالج ينفّذ ولم تلتزم له كتابة بعد؛
 * - `committed`: كتابة له التزمت ومعها علامة المفتاح، فلا حاجة لعلامة ثانية؛
 * - `closed`: انتهى المعالج، وما يكتبه المعترض بعده (حفظ الرد، تحرير المفتاح) ليس من كتابة الطلب.
 */
export interface IdempotencySlot {
  readonly userId: string;
  readonly key: string;
  state: 'open' | 'committed' | 'closed';
}

export const idempotencySlot = new AsyncLocalStorage<IdempotencySlot>();

const openSlot = (): IdempotencySlot | undefined => {
  const slot = idempotencySlot.getStore();
  return slot?.state === 'open' ? slot : undefined;
};

/**
 * شرط علامة الالتزام: المعاملة عدّلت فعلًا. دليله من القاعدة نفسها: للمعاملة رقم معاملة، وتحمل قفل ROW EXCLUSIVE على جدول غير جدول
 * المفاتيح (تأخذه جمل INSERT وUPDATE وDELETE). القراءة، والقراءة بقفل صفوف (FOR UPDATE)، وجملة تعديل لم تمسّ صفًّا لا تستهلك المفتاح،
 * فطلب فشل قبل أن يكتب يبقى مفتاحه قابلًا للإعادة. الخطأ الممكن في اتجاه واحد: معاملة جمعت قفل صفوف وجملة تعديل بلا أثر تُعدّ كاتبة.
 */
const WROTE = `pg_current_xact_id_if_assigned() IS NOT NULL
  AND EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
               WHERE l.locktype = 'relation' AND l.pid = pg_backend_pid() AND l.mode = 'RowExclusiveLock'
                 AND c.relkind = 'r' AND c.oid <> 'idempotency_keys'::regclass)`;
const MARK = `UPDATE idempotency_keys SET state = 'committed' WHERE user_id = $1 AND key = $2 AND state = 'in_progress' AND ${WROTE}`;

/**
 * يجعل كل كتابة ينفّذها معالج طلب يحمل `Idempotency-Key` تلتزم مع علامة مفتاحه في معاملة واحدة (ADR 0005): تلتزمان معًا أو تتراجعان معًا.
 * - `db.transaction`: العلامة آخر جملة قبل الالتزام؛
 * - جملة مباشرة على المجمّع خارج معاملة وليست قراءة: تُنفَّذ مع العلامة في معاملة قصيرة.
 * خارج طلب كهذا (العمّال، الحراس، ما يكتبه المعترض نفسه) لا يتغيّر شيء.
 */
export function withCommitMarker(db: Database, pool: Pool): Database {
  const transaction = db.transaction.bind(db);
  db.transaction = ((run, config) => {
    const slot = openSlot();
    if (!slot) return transaction(run, config);
    let marked = false;
    return transaction(async (tx) => {
      const result = await run(tx);
      const mark = await tx
        .update(idempotencyKeys)
        .set({ state: 'committed' })
        .where(and(eq(idempotencyKeys.userId, slot.userId), eq(idempotencyKeys.key, slot.key), eq(idempotencyKeys.state, 'in_progress'), sql.raw(WROTE)));
      marked = (mark.rowCount ?? 0) > 0;
      return result;
    }, config).then((result) => {
      if (marked) slot.state = 'committed';
      return result;
    });
  }) as Database['transaction'];

  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  pool.query = ((...args: unknown[]) => {
    const slot = openSlot();
    const first = args[0] as string | { text?: unknown } | undefined;
    const text = typeof first === 'string' ? first : first?.text;
    // القراءة تمر كما هي؛ وصيغة الاستدعاء بدالة رد لا يستعملها Drizzle
    if (!slot || typeof text !== 'string' || /^\s*select\b/i.test(text) || typeof args[args.length - 1] === 'function') return query(...args);
    return (async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await (client.query.bind(client) as (...a: unknown[]) => Promise<unknown>)(...args);
        const mark = await client.query(MARK, [slot.userId, slot.key]);
        await client.query('COMMIT');
        if (mark.rowCount) slot.state = 'committed';
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })();
  }) as Pool['query'];
  return db;
}
