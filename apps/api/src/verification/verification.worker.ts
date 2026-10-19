import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig, storageConfigured } from '../config/config';
import { LOGGER } from '../common/logger';
import { DB, type Database } from '../database/database.module';
import { uploadSessions } from '../database/schema/schema';
import { OBJECT_STORAGE, type ObjectStorage, StorageConfigError } from './object-storage';
import { inspectUpload, recordVerification } from './verification';

/**
 * التحقق داخل الخادم إلى أن يوجد عامل الوسائط (UPLOAD_VERIFIER=in_process). الطابور هو حالة الجلسة نفسها:
 * كل جلسة `completed` تُقفل بـ FOR UPDATE SKIP LOCKED وتُفحص وتُطبَّق نتيجتها بـ recordVerification، فعدة نسخ
 * تعمل معًا ولا يضيع شيء بإعادة التشغيل. عامل الوسائط يحل محله بضبط UPLOAD_VERIFIER=external واستدعاء
 * recordVerification نفسها.
 */
@Injectable()
export class VerificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
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
    if (this.config.UPLOAD_VERIFIER !== 'in_process') return;
    if (!storageConfigured(this.config)) {
      // خارج الإنتاج فقط (الإنتاج يرفض البدء بلا تخزين): الجلسات تبقى completed حتى يُضبط التخزين
      this.logger.warn('object storage is not configured: in-process upload verification is off');
      return;
    }
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** يتحقق من جلسة مكتملة واحدة؛ يعيد false إن لم تبقَ واحدة. */
  async verifyNext(): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.state, 'completed'))
        .orderBy(asc(uploadSessions.updatedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!session) return false;
      let outcome;
      try {
        outcome = await inspectUpload(this.storage, this.config.S3_BUCKET_UPLOADS, session);
      } catch (err) {
        // عطل مؤقت في التخزين أو خطأ تهيئة: تبقى الجلسة completed وتتأخر في الطابور ليُعاد لاحقًا دون أن تحجب غيرها.
        // خطأ التهيئة (حاوية مفقودة أو بلا صلاحية) ينبَّه بمستوى error لأنه لا يزول وحده.
        const configError = err instanceof StorageConfigError;
        this.logger[configError ? 'error' : 'warn'](
          { upload_session_id: session.id, err_name: (err as Error)?.name },
          configError ? 'verification blocked: object storage misconfigured' : 'verification deferred',
        );
        await tx.update(uploadSessions).set({ updatedAt: sql`now()` }).where(eq(uploadSessions.id, session.id));
        // تنتهي الدفعة هنا: التخزين المعطّل لا يُستدعى في حلقة متصلة
        return false;
      }
      await recordVerification(tx, session, outcome);
      return true;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = (async () => {
        while (!this.stopped && (await this.verifyNext()));
      })()
        .catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'verification failed'))
        .finally(() => this.schedule());
    }, this.config.VERIFY_POLL_INTERVAL_MS);
  }
}
