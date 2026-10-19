import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig, storageConfigured } from '../config/config';
import { LOGGER } from '../common/logger';
import { DB, type Database } from '../database/database.module';
import { uploadSessions } from '../database/schema/schema';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { markReceived, markUploadFailed } from './upload-completion';

export interface ReconcileResult {
  received: number;
  expired: number;
  pending: number;
}

/**
 * مكنسة تسوية لجلسات `in_progress` التي ضاع خطّاف post-finish لها (انقطاع ثوانٍ بين tusd والخادم أطول من إعادة
 * محاولته): بعد UPLOAD_RECONCILE_STALE_SECONDS بلا تغيير تُفحص في التخزين. الكائن النهائي لا يوجد في s3store إلا بعد
 * اكتمال الرفع، فوجوده = استلام كما لو وصل post-finish (والمُتحقق يفحص الحجم والبصمة بعدها)، وغيابه بعد انتهاء
 * الجلسة = فشل expired، وغيابه قبلها = رفع جارٍ يُعاد فحصه لاحقًا. القفل SKIP LOCKED على الصف نفسه الذي يقفله
 * post-finish، فلا يُستلم ملف مرتين.
 */
@Injectable()
export class UploadReconciler implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.UPLOAD_RECONCILE_ENABLED || this.config.UPLOAD_PATH !== 'tusd') return;
    if (!storageConfigured(this.config)) {
      this.logger.warn('object storage is not configured: upload reconciliation is off');
      return;
    }
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** دفعة واحدة؛ تقف عند أول عطل تخزين فلا يُستدعى التخزين المعطّل في حلقة. */
  async reconcileBatch(limit = this.config.UPLOAD_RECONCILE_BATCH): Promise<ReconcileResult> {
    const result: ReconcileResult = { received: 0, expired: 0, pending: 0 };
    await this.db.transaction(async (tx) => {
      const stale = await tx
        .select()
        .from(uploadSessions)
        .where(
          and(
            eq(uploadSessions.state, 'in_progress'),
            lt(uploadSessions.updatedAt, sql`now() - make_interval(secs => ${this.config.UPLOAD_RECONCILE_STALE_SECONDS})` as never),
          ),
        )
        .orderBy(asc(uploadSessions.updatedAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      for (const session of stale) {
        const key = session.storageKey ?? `${this.config.TUSD_OBJECT_PREFIX}${session.id}`;
        let head;
        try {
          head = await this.storage.head(this.config.S3_BUCKET_UPLOADS, key);
        } catch (err) {
          this.logger.warn({ upload_session_id: session.id, err_name: (err as Error)?.name }, 'upload reconciliation deferred');
          break;
        }
        if (head) {
          await markReceived(tx, session, key);
          result.received++;
        } else if (new Date(session.expiresAt) <= new Date()) {
          await markUploadFailed(tx, session, 'expired');
          result.expired++;
        } else {
          // رفع جارٍ (أو متوقف ينتظر الاستئناف): يُعاد فحصه بعد مهلة أخرى
          await tx.update(uploadSessions).set({ updatedAt: sql`now()` }).where(eq(uploadSessions.id, session.id));
          result.pending++;
        }
      }
    });
    if (result.received || result.expired) this.logger.info(result, 'uploads reconciled');
    return result;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.reconcileBatch()
        .catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'upload reconciliation failed'))
        .finally(() => this.schedule());
    }, this.config.UPLOAD_RECONCILE_INTERVAL_MS);
  }
}
