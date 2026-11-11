import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { withCommitMarker } from '../idempotency/commit-marker';
import * as schema from './schema/schema';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** أي منفّذ استعلامات: القاعدة نفسها أو معاملة مفتوحة. */
export type Executor = Database | Tx;

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_MAX }),
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
