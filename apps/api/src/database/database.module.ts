import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import { pgError } from '../common/db-errors';
import { LOGGER } from '../common/logger';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { withCommitMarker } from '../idempotency/commit-marker';
import * as schema from './schema/schema';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** أي منفّذ استعلامات: القاعدة نفسها أو معاملة مفتوحة. */
export type Executor = Database | Tx;

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

/** أقصى انتظار لاتصال من المجمّع (أو لفتح اتصال جديد). بعده يرد الطلب 503 بدل أن يُعلَّق (ADR 0028). */
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * مجمّع الاتصالات بحدوده (ADR 0028، تعديل 2026-11-11):
 * - اتصال تقطعه القاعدة (إعادة تشغيلها، تبديل الأساسي، قطع شبكي، تجاوز مهلة المعاملة الخاملة) يصدر حدث خطأ على الاتصال نفسه،
 *   وإن كان خاملًا فعلى المجمّع أيضًا؛ وحدث خطأ بلا مستمع يُسقط العملية كلها. المستمع على كل اتصال يسجّل اسم الخطأ ورمز Postgres
 *   وحدهما (كائن الخطأ يحمل معاملات الاتصال)، والمجمّع يُخرج الاتصال ويفتح غيره عند أول طلب.
 * - مهلة الاستعلام ومهلة المعاملة الخاملة تُرسَلان معاملَي بدء على كل اتصال، فلا استعلام ولا معاملة منسية تحجز اتصالًا بلا نهاية.
 */
export function createPool(config: AppConfig, logger: Logger): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // 0 = لا يُرسَل المعامل وتبقى قيمة القاعدة
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS || undefined,
    idle_in_transaction_session_timeout: config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS || undefined,
  });
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      const { code } = pgError(err);
      logger.warn({ err_name: err.name, ...(code ? { pg_code: code } : {}) }, 'database connection lost');
    });
  });
  // خطأ الاتصال الخامل يبلغ المجمّع بعد أن سجّله مستمع الاتصال أعلاه؛ هذا المستمع يمنع سقوط العملية فقط
  pool.on('error', () => undefined);
  return pool;
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG, LOGGER],
      useFactory: createPool,
    },
    {
      provide: DB,
      inject: [PG_POOL],
      // كتابة الطلب الحامل لـ Idempotency-Key تلتزم مع علامة مفتاحه (ADR 0005)
      useFactory: (pool: Pool): Database => withCommitMarker(drizzle(pool, { schema }), pool),
    },
  ],
  exports: [PG_POOL, DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
