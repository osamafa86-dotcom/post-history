import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { notifications } from '../database/schema/schema';

/** «مادة واردة»: مهمة كل مشرف في النطاق، يغلقها استلام المادة (خروجها من inbox). */
export const RECEIPT_TYPES: readonly string[] = ['material.created', 'material.urgent_received'];
/** «قُبلت للإنتاج»: مهمة كل منتج، يغلقها إسناد المادة إلى أحدهم (ADR 0096). */
export const PRODUCTION_TYPES: readonly string[] = ['material.accepted_for_production'];

/**
 * يغلق مهام المادة المفتوحة من هذه الأنواع ومهام تصعيدها: أحدٌ تولّى الأمر، فلا تبقى «لم يُقرّ» في اللوحة ولا تُصعَّد.
 * إشعار الفاعل نفسه يصير مقروءًا مُقرًّا؛ إشعارات غيره تبقى بحالتها في صناديقهم (acknowledged_at يتبع الحالة، قيد
 * notifications_ack_consistent) ومهمتها مغلقة بلا موعد تصعيد. في معاملة المستدعي.
 */
export async function closeMaterialTasks(tx: Tx, materialId: string, types: readonly string[], actorId: string | null): Promise<void> {
  const typeList = sql.join(
    types.map((t) => sql`${t}`),
    sql`, `,
  );
  const own = actorId ? sql`${notifications.userId} = ${actorId}` : sql`false`;
  await tx
    .update(notifications)
    .set({
      state: sql`CASE WHEN ${own} THEN 'acknowledged' ELSE ${notifications.state} END`,
      readAt: sql`CASE WHEN ${own} THEN COALESCE(${notifications.readAt}, now()) ELSE ${notifications.readAt} END`,
      acknowledgedAt: sql`CASE WHEN ${own} THEN now() ELSE ${notifications.acknowledgedAt} END`,
      assignmentState: 'acknowledged',
      escalateAt: null,
    })
    .where(
      and(
        eq(notifications.materialId, materialId),
        eq(notifications.assignmentState, 'assigned'),
        isNull(notifications.acknowledgedAt),
        or(
          inArray(notifications.type, [...types]),
          // التصعيد إلى رئيس التحرير ومدير النظام عن مهمة من هذه الأنواع (الحدث يسمّي الإشعار الأصلي)
          and(
            eq(notifications.type, 'notification.escalated'),
            sql`EXISTS (SELECT 1 FROM outbox_events e JOIN notifications o ON o.id = (e.payload->>'notification_id')::uuid
                        WHERE e.id = ${notifications.eventId} AND o.type IN (${typeList}))`,
          ),
        ),
      ),
    );
}
