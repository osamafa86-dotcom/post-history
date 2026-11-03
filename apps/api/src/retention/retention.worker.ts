import { Inject, Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from '../common/logger';
import { DB, type Database } from '../database/database.module';

export interface SweepResult {
  idempotency_keys: number;
  refresh_tokens: number;
  upload_filenames: number;
  notifications: number;
}

/**
 * الكنس الدوري (ADR 0116) لما انتهت حاجته التقنية ويبقى بيانات شخصية أو ردودًا محفوظة بلا داعٍ:
 * - مفاتيح منع التكرار بعد انتهاء عمرها (24 ساعة)، وردودها المحفوظة معها؛
 * - رموز التحديث بعد موتها (انتهاء أو إبطال) بمدة، إلا ما يشير إليه رمز لم يحن حذفه (`replaced_by`)؛
 * - اسم الملف على الجهاز وبصمة العميل في جلسة الرفع المنتهية (`verified` و`failed` و`deduplicated`) بعد مدة: يُمحيان ويبقى الصف
 *   لأن ملفات المادة تشير إليه؛
 * - الإشعارات المقروءة بعد مدة، إلا مهمة لم يُقرّ استلامها.
 * دفعات محدودة في كل دورة فلا تطول معاملة. السجل أعداد وحدها. ما لا يُكنس هنا (المواد والأصول وبيانات المشترين والتدقيق) قرار المالك.
 */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.RETENTION_SWEEP_ENABLED) this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** دورة كنس واحدة على الجداول الأربعة؛ يعيد ما حُذف أو مُحي من كلٍّ. */
  async sweep(): Promise<SweepResult> {
    const c = this.config;
    const batch = c.RETENTION_SWEEP_BATCH;
    const count = async (q: ReturnType<typeof sql>) => Number((await this.db.execute<{ n: string }>(q)).rows[0]?.n ?? 0);
    const result: SweepResult = {
      idempotency_keys: await count(sql`
        WITH gone AS (
          DELETE FROM idempotency_keys WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at <= now() LIMIT ${batch})
          RETURNING 1)
        SELECT count(*)::text AS n FROM gone`),
      refresh_tokens: await count(sql`
        WITH dead AS (
          SELECT id FROM refresh_tokens
           WHERE LEAST(expires_at, COALESCE(revoked_at, expires_at)) < now() - make_interval(days => ${c.RETENTION_REFRESH_TOKEN_DAYS})
           LIMIT ${batch}),
        gone AS (
          DELETE FROM refresh_tokens t USING dead d
           WHERE t.id = d.id
             AND NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.replaced_by = t.id AND r.id NOT IN (SELECT id FROM dead))
          RETURNING 1)
        SELECT count(*)::text AS n FROM gone`),
      upload_filenames: await count(sql`
        WITH scrubbed AS (
          UPDATE upload_sessions SET filename = '-', client_fingerprint = NULL
           WHERE id IN (SELECT id FROM upload_sessions
                         WHERE state IN ('verified', 'failed', 'deduplicated') AND filename <> '-'
                           AND updated_at < now() - make_interval(days => ${c.RETENTION_UPLOAD_FILENAME_DAYS})
                         LIMIT ${batch})
          RETURNING 1)
        SELECT count(*)::text AS n FROM scrubbed`),
      notifications: await count(sql`
        WITH gone AS (
          DELETE FROM notifications
           WHERE id IN (SELECT id FROM notifications
                         WHERE read_at IS NOT NULL AND read_at < now() - make_interval(days => ${c.RETENTION_READ_NOTIFICATION_DAYS})
                           AND (assignment_state IS DISTINCT FROM 'assigned' OR acknowledged_at IS NOT NULL)
                         LIMIT ${batch})
          RETURNING 1)
        SELECT count(*)::text AS n FROM gone`),
    };
    if (Object.values(result).some((n) => n > 0)) this.logger.info(result, 'retention sweep');
    return result;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.sweep()
        .catch((err: unknown) => this.logger.warn({ err_name: (err as Error)?.name }, 'retention sweep failed'))
        .finally(() => this.schedule());
    }, this.config.RETENTION_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }
}

@Module({ providers: [RetentionWorker], exports: [RetentionWorker] })
export class RetentionModule {}
