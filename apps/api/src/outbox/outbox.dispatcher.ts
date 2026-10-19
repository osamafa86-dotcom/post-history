import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from '../common/logger';
import { DB, type Database, type Tx } from '../database/database.module';
import { fanOut } from '../notifications/fanout';
import { outboxEvents } from '../database/schema/schema';

export type OutboxRow = typeof outboxEvents.$inferSelect;

/**
 * وجهة الأحداث (صندوق الوارد، ولاحقًا WebSocket والهاتف). تُستدعى داخل معاملة المُرسل: ما تكتبه في القاعدة
 * يُثبَّت مع علامة النشر معًا أو لا يُثبَّت. الفشل يرمي فيُعاد المحاولة لاحقًا.
 */
export interface OutboxPublisher {
  publish(event: OutboxRow, tx: Tx): Promise<void>;
}
export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

/** الناشر في التأسيس: إشعارات صندوق الوارد، ثم سطر سجل بمعرّف الحدث ونوعه فقط (لا الحمولة). */
@Injectable()
export class InboxOutboxPublisher implements OutboxPublisher {
  constructor(
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async publish(event: OutboxRow, tx: Tx): Promise<void> {
    const created = await fanOut(tx, event, {
      locale: this.config.NOTIFICATION_LOCALE,
      escalationSeconds: { urgent: this.config.ESCALATION_URGENT_SECONDS, important: this.config.ESCALATION_IMPORTANT_SECONDS },
    });
    this.logger.debug({ event_id: event.id, type: event.type, notifications: created }, 'outbox event published');
  }
}

const MAX_BACKOFF_SECONDS = 300;

/**
 * مُرسل مستقل يقرأ Outbox بـ FOR UPDATE SKIP LOCKED: عدة نسخ تعمل معًا دون أن يُرسل حدث مرتين في الوقت نفسه.
 * التسليم «مرة واحدة على الأقل»؛ المستهلكون يزيلون التكرار بـ idempotency_key.
 */
@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | undefined;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.OUTBOX_DISPATCHER_ENABLED) this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** يعالج دفعة واحدة؛ يعيد عدد الأحداث المنشورة. */
  async dispatchBatch(limit = this.config.OUTBOX_BATCH_SIZE): Promise<number> {
    return this.db.transaction(async (tx) => {
      const batch = await tx
        .select()
        .from(outboxEvents)
        .where(and(isNull(outboxEvents.publishedAt), lte(outboxEvents.nextAttemptAt, sql`now()`)))
        .orderBy(asc(outboxEvents.id))
        .limit(limit)
        .for('update', { skipLocked: true });

      let published = 0;
      for (const event of batch) {
        try {
          // نقطة حفظ لكل حدث: فشل حدث لا يلغي ما كتبته الأحداث الأخرى في الدفعة
          await tx.execute(sql`SAVEPOINT outbox_event`);
          await this.publisher.publish(event, tx);
          await tx.execute(sql`RELEASE SAVEPOINT outbox_event`);
          await tx.update(outboxEvents).set({ publishedAt: sql`now()` }).where(eq(outboxEvents.id, event.id));
          published += 1;
        } catch (err) {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT outbox_event`);
          const backoff = Math.min(2 ** event.attempts, MAX_BACKOFF_SECONDS);
          await tx
            .update(outboxEvents)
            .set({
              attempts: event.attempts + 1,
              nextAttemptAt: sql`now() + make_interval(secs => ${backoff})`,
              // اسم الخطأ فقط: رسائل الأخطاء قد تحمل بيانات
              lastError: err instanceof Error ? err.name : 'Error',
            })
            .where(eq(outboxEvents.id, event.id));
        }
      }
      return published;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.dispatchBatch()
        .catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'outbox dispatch failed'))
        .finally(() => this.schedule());
    }, this.config.OUTBOX_POLL_INTERVAL_MS);
  }
}
