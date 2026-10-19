import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from '../common/logger';
import { DB, type Database } from '../database/database.module';
import { notifications, userRoles, users } from '../database/schema/schema';
import type { RoleName } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';

/**
 * سلم التصعيد: المهمة التي لم يُقرّ استلامها (المشرف أو المنتج) تُصعَّد إلى رئيس التحرير، ثم إلى مدير النظام.
 * كلاهما نطاقه كل المواد، فهو «الدور الأعلى في النطاق». بعد آخر درجة لا تصعيد.
 */
export const ESCALATION_LADDER: readonly RoleName[] = ['editor_in_chief', 'system_admin'];

@Injectable()
export class EscalationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.OUTBOX_DISPATCHER_ENABLED) return;
    this.timer = setInterval(() => {
      this.escalateDue().catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'escalation failed'));
    }, this.config.ESCALATION_POLL_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * يصعّد ما حان موعده ولم يُقرّ: يرفع escalation_level ويضبط الموعد التالي، ويكتب حدث notification.escalated
   * لكل مستخدم نشط في الدرجة التالية (المُرسل يحوّله إلى إشعار). يعيد عدد الإشعارات المصعَّدة.
   */
  async escalateDue(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(notifications)
        .where(and(isNull(notifications.acknowledgedAt), lte(notifications.escalateAt, sql`now()`)))
        .orderBy(asc(notifications.escalateAt))
        .limit(100)
        .for('update', { skipLocked: true });

      for (const n of due) {
        const level = n.escalationLevel + 1;
        const role = ESCALATION_LADDER[level - 1];
        const delay = n.priority === 'urgent' ? this.config.ESCALATION_URGENT_SECONDS : this.config.ESCALATION_IMPORTANT_SECONDS;
        await tx
          .update(notifications)
          .set({
            escalationLevel: role ? level : n.escalationLevel,
            escalateAt: role && level < ESCALATION_LADDER.length ? sql`now() + make_interval(secs => ${delay})` : null,
          })
          .where(eq(notifications.id, n.id));
        if (!role) continue;
        const targets = await tx
          .selectDistinct({ id: userRoles.userId })
          .from(userRoles)
          .innerJoin(users, eq(users.id, userRoles.userId))
          .where(and(eq(userRoles.role, role), eq(users.status, 'active')));
        for (const t of targets) {
          await writeOutboxEvent(tx, {
            type: 'notification.escalated',
            aggregateType: 'notification',
            aggregateId: n.id,
            idempotencyKey: `notification.escalated:${n.id}:${level}:${t.id}`,
            payload: {
              notification_id: n.id,
              material_id: n.materialId,
              priority: n.priority,
              escalation_level: level,
              escalated_to: t.id,
            },
          });
        }
      }
      return due.length;
    });
  }
}
