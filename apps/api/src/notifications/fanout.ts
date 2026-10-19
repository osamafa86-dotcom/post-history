import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { materials, notifications, offices, userRoles, users } from '../database/schema/schema';
import type { OutboxRow } from '../outbox/outbox.dispatcher';
import { materialRef, notificationTitle, type Locale } from './messages';

type Audience = 'supervisors' | 'producers' | 'reporter';

/** من يُشعَر بكل نوع حدث، وهل هي مهمة («أُسند» ثم «أقرّ الاستلام»). ما ليس هنا لا يولّد إشعارًا. */
const RULES: Record<string, { audience: Audience; assignment: boolean; skipUrgent?: boolean }> = {
  // المادة العاجلة تصل بحدثين؛ إشعار واحد من urgent_received
  'material.created': { audience: 'supervisors', assignment: true, skipUrgent: true },
  'material.urgent_received': { audience: 'supervisors', assignment: true },
  'material.acknowledged': { audience: 'reporter', assignment: false },
  'material.change_requested': { audience: 'reporter', assignment: false },
  'material.accepted_for_production': { audience: 'producers', assignment: true },
  'material.published': { audience: 'reporter', assignment: false },
  // إشعار الاستلام: يصل حين يتحقق الأصل ويصدر رقم الإيصال
  'upload.verified': { audience: 'reporter', assignment: false },
};

/**
 * يحوّل حدث Outbox إلى إشعارات في صندوق الوارد داخل معاملة المُرسل نفسها. ذاتي التكرار: (user_id, event_id) فريد،
 * فإعادة إرسال الحدث لا تكرر الإشعار. يعيد عدد الإشعارات الجديدة.
 */
export async function fanOut(tx: Tx, event: OutboxRow, locale: Locale): Promise<number> {
  const rule = RULES[event.type];
  const payload = event.payload as Record<string, unknown>;
  const materialId = typeof payload.material_id === 'string' ? payload.material_id : undefined;
  if (!rule || !materialId) return 0;
  if (event.type === 'upload.verified' && (payload.kind !== 'original' || typeof payload.receipt_number !== 'string')) return 0;

  const [m] = await tx
    .select({ id: materials.id, reporterId: materials.reporterId, officeId: materials.officeId, priority: materials.priority, governorate: offices.governorate })
    .from(materials)
    .leftJoin(offices, eq(offices.id, materials.officeId))
    .where(eq(materials.id, materialId));
  if (!m) return 0;
  if (rule.skipUrgent && m.priority === 'urgent') return 0;

  const recipients = await audience(tx, rule.audience, m);
  if (recipients.length === 0) return 0;
  const title = notificationTitle(event.type, locale, {
    ref: materialRef(m.id),
    receipt: typeof payload.receipt_number === 'string' ? payload.receipt_number : undefined,
  });
  const rows = await tx
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        userId,
        eventId: event.id,
        type: event.type,
        materialId: m.id,
        title,
        priority: m.priority,
        assignmentState: rule.assignment ? 'assigned' : null,
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  return rows.length;
}

async function audience(
  tx: Tx,
  who: Audience,
  m: { reporterId: string; officeId: string | null; governorate: string | null },
): Promise<string[]> {
  if (who === 'reporter') return [m.reporterId];
  const role = who === 'supervisors' ? 'supervisor' : 'producer';
  // المشرف يُشعَر بما في نطاقه فقط (كل شيء، أو مكتب المادة، أو محافظة مكتبها)
  const inScope =
    who === 'supervisors'
      ? sql`(${userRoles.scopeKind} = 'all'
            OR (${userRoles.scopeKind} = 'office' AND ${userRoles.scopeId} = ${m.officeId ?? ''})
            OR (${userRoles.scopeKind} = 'governorate' AND ${userRoles.scopeId} = ${m.governorate ?? ''}))`
      : sql`true`;
  const rows = await tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, role), eq(users.status, 'active'), inScope));
  return rows.map((r) => r.userId);
}

