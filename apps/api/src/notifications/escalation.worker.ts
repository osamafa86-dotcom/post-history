import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from '../common/logger';
import { DB, type Database, type Tx } from '../database/database.module';
import { materialAssignments, materials, notificationRuleEscalations, notifications, offices, outboxEvents, userRoles, users } from '../database/schema/schema';
import type { RoleName } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';
import { ruleRecipients } from './rule-fanout';
import { PRODUCTION_TYPES, RECEIPT_TYPES } from './task-closure';

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
   * لكل مستخدم نشط في الدرجة التالية (المُرسل يحوّله إلى إشعار). نسخ المهمة نفسها للمادة (كل مشرف أو كل منتج) تتقدم معًا
   * بحدث واحد، فيُصعَّد كل درج مرة واحدة للمادة. والمهمة التي حُسمت خارج الإشعار (استُلمت المادة، أو أُسندت، أو أقرّ أحد
   * المستلمين) تُغلق بلا تصعيد (assignment_state بلا موعد؛ acknowledged_at لمن أقرّ وحده). يعيد عدد المهام المصعَّدة.
   */
  async escalateDue(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(notifications)
                // مهمة مفتوحة وحدها: المغلقة بحسم غيرها (assignment_state acknowledged) لا تعود إلى السلسلة ولو بقي لها موعد
        .where(and(isNull(notifications.acknowledgedAt), eq(notifications.assignmentState, 'assigned'), lte(notifications.escalateAt, sql`now()`)))
        .orderBy(asc(notifications.escalateAt))
        .limit(100)
        .for('update', { skipLocked: true });

      const seen = new Set<string>();
      let escalated = 0;
      for (const n of due) {
        if (seen.has(n.id)) continue;
        const group = await siblings(tx, n);
        for (const id of group) seen.add(id);
        if (await settled(tx, n)) {
          await tx
            .update(notifications)
            .set({ assignmentState: 'acknowledged', escalateAt: null })
            .where(inArray(notifications.id, group));
          continue;
        }
        escalated++;
        if (n.ruleId) {
          await this.escalateByRule(tx, n, group);
          continue;
        }
        const level = n.escalationLevel + 1;
        const role = ESCALATION_LADDER[level - 1];
        const delay = n.priority === 'urgent' ? this.config.ESCALATION_URGENT_SECONDS : this.config.ESCALATION_IMPORTANT_SECONDS;
        await tx
          .update(notifications)
          .set({
            escalationLevel: role ? level : n.escalationLevel,
            escalateAt: role && level < ESCALATION_LADDER.length ? sql`now() + make_interval(secs => ${delay})` : null,
          })
          .where(inArray(notifications.id, group));
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
      return escalated;
    });
  }

  /**
   * سلسلة قاعدة الإدارة (v0.2): المستوى التالي يصل أدواره ضمن نطاق المادة، وموعد المستوى بعده من الإشعار الأول
   * (after_seconds). بعد آخر مستوى لا تصعيد.
   */
  private async escalateByRule(tx: Tx, n: typeof notifications.$inferSelect, group: string[]): Promise<void> {
    const level = n.escalationLevel + 1;
    const steps = await tx
      .select()
      .from(notificationRuleEscalations)
      .where(eq(notificationRuleEscalations.ruleId, n.ruleId!))
      .orderBy(asc(notificationRuleEscalations.level));
    const step = steps.find((s) => s.level === level);
    const next = steps.find((s) => s.level === level + 1);
    await tx
      .update(notifications)
      .set({
        escalationLevel: step ? level : n.escalationLevel,
        escalateAt: step && next ? sql`${notifications.createdAt} + make_interval(secs => ${next.afterSeconds})` : null,
      })
      .where(inArray(notifications.id, group));
    if (!step || !n.materialId) return;
    const [m] = await tx
      .select({
        id: materials.id,
        reporterId: materials.reporterId,
        officeId: materials.officeId,
        priority: materials.priority,
        materialTypes: materials.materialTypes,
        governorate: offices.governorate,
      })
      .from(materials)
      .leftJoin(offices, eq(offices.id, materials.officeId))
      .where(eq(materials.id, n.materialId));
    if (!m) return;
    for (const to of await ruleRecipients(tx, step.recipientRoles, [], m)) {
      if (to === n.userId) continue;
      await writeOutboxEvent(tx, {
        type: 'notification.escalated',
        aggregateType: 'notification',
        aggregateId: n.id,
        idempotencyKey: `notification.escalated:${n.id}:${level}:${to}`,
        payload: { notification_id: n.id, material_id: n.materialId, priority: n.priority, escalation_level: level, escalated_to: to },
      });
    }
  }
}

type NotificationRow = typeof notifications.$inferSelect;

/**
 * نسخ المهمة نفسها للمادة: النوع والقاعدة نفساهما، مفتوحة وبموعد تصعيد، مقفولة لهذه المعاملة (مع الإشعار نفسه). المهمة
 * بلا مادة (طلب الاستعادة) وحدها.
 */
async function siblings(tx: Tx, n: NotificationRow): Promise<string[]> {
  if (!n.materialId) return [n.id];
  const rows = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.materialId, n.materialId),
        eq(notifications.type, n.type),
        sql`${notifications.ruleId} IS NOT DISTINCT FROM ${n.ruleId}`,
        isNull(notifications.acknowledgedAt),
        eq(notifications.assignmentState, 'assigned'),
        isNotNull(notifications.escalateAt),
        ne(notifications.id, n.id),
      ),
    )
    .for('update', { skipLocked: true });
  return [n.id, ...rows.map((r) => r.id)];
}

/**
 * حُسمت المهمة خارج الإشعار فلا تصعيد: أقرّ أحد مستلمي الحدث نفسه، أو خرجت المادة من inbox بعد «مادة واردة»، أو أُسندت
 * (أو خرجت من accepted) بعد «قُبلت للإنتاج».
 */
async function settled(tx: Tx, n: NotificationRow): Promise<boolean> {
  if (!n.materialId) return false;
  const [acked] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.materialId, n.materialId),
        eq(notifications.eventId, n.eventId),
        sql`${notifications.ruleId} IS NOT DISTINCT FROM ${n.ruleId}`,
        isNotNull(notifications.acknowledgedAt),
      ),
    )
    .limit(1);
  if (acked) return true;
  const receipt = RECEIPT_TYPES.includes(n.type);
  const production = PRODUCTION_TYPES.includes(n.type);
  if (!receipt && !production) return false;
  const [m] = await tx
    .select({ editorialState: materials.editorialState, acknowledgedAt: materials.acknowledgedAt })
    .from(materials)
    .where(eq(materials.id, n.materialId));
  if (!m) return false;
  if (receipt) return m.editorialState !== 'inbox' || m.acknowledgedAt !== null;
  if (m.editorialState !== 'accepted') return true;
  const [assigned] = await tx
    .select({ id: materialAssignments.id })
    .from(materialAssignments)
    .innerJoin(outboxEvents, eq(outboxEvents.id, n.eventId))
    .where(and(eq(materialAssignments.materialId, n.materialId), gte(materialAssignments.createdAt, outboxEvents.occurredAt)))
    .limit(1);
  return !!assigned;
}
