import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { materials, notifications, offices, userRoles, users } from '../database/schema/schema';
import { highestRank, type RoleName } from '../identity/principal';
import type { OutboxRow } from '../outbox/outbox.dispatcher';
import { materialRef, notificationTitle, type Locale } from './messages';

type Audience = 'supervisors' | 'producers' | 'reporter' | 'escalated_to';

export interface FanOutOptions {
  locale: Locale;
  /** مهلة الإقرار قبل التصعيد بالثواني لكل أولوية؛ العادية لا تُصعَّد. */
  escalationSeconds: { urgent: number; important: number };
}

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
  // التصعيد يصل المستخدم المسمّى في الحدث؛ لا يُصعَّد هو نفسه (السلسلة تتقدم على الإشعار الأصلي)
  'notification.escalated': { audience: 'escalated_to', assignment: true },
};

/**
 * يحوّل حدث Outbox إلى إشعارات في صندوق الوارد داخل معاملة المُرسل نفسها. ذاتي التكرار: (user_id, event_id) فريد،
 * فإعادة إرسال الحدث لا تكرر الإشعار. يعيد عدد الإشعارات الجديدة.
 */
export async function fanOut(tx: Tx, event: OutboxRow, opts: FanOutOptions): Promise<number> {
  const payload = event.payload as Record<string, unknown>;
  if (event.type === 'auth.recovery_requested') return recoveryRequested(tx, event, payload, opts);
  const rule = RULES[event.type];
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

  const recipients =
    rule.audience === 'escalated_to'
      ? typeof payload.escalated_to === 'string'
        ? [payload.escalated_to]
        : []
      : await audience(tx, rule.audience, m);
  if (recipients.length === 0) return 0;
  const delay = rule.assignment && rule.audience !== 'escalated_to' ? opts.escalationSeconds[m.priority as 'urgent'] : undefined;
  const title = notificationTitle(event.type, opts.locale, {
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
        escalateAt: delay ? sql`now() + make_interval(secs => ${delay})` : null,
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  return rows.length;
}

async function audience(
  tx: Tx,
  who: Exclude<Audience, 'escalated_to'>,
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


/**
 * طلب استعادة: مهمة لمن يملك اعتماده بمعرّف الطلب، وتنبيه لصاحب الحساب على أجهزته القائمة. بلا مادة.
 * من يملك الاعتماد يتبع قاعدة التسلسل (identity/principal.ts): مشرفو نطاق صاحب الحساب، إلا إن كان دوره أعلى من
 * المشرف فمديرو النظام وحدهم (غير صاحب الحساب نفسه).
 */
async function recoveryRequested(tx: Tx, event: OutboxRow, payload: Record<string, unknown>, opts: FanOutOptions): Promise<number> {
  const requestId = typeof payload.recovery_request_id === 'string' ? payload.recovery_request_id : undefined;
  if (!requestId) return 0;
  const [owner] = await tx
    .select({ id: users.id, officeId: users.officeId, governorate: offices.governorate })
    .from(users)
    .leftJoin(offices, eq(offices.id, users.officeId))
    .where(eq(users.id, event.aggregateId));
  if (!owner) return 0;
  const ownerRoles = await tx.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, owner.id));
  const approvers =
    highestRank(ownerRoles.map((r) => r.role as RoleName)) > highestRank(['supervisor'])
      ? await systemAdmins(tx)
      : await audience(tx, 'supervisors', { reporterId: owner.id, officeId: owner.officeId, governorate: owner.governorate });
  const rows = [
    ...approvers
      .filter((id) => id !== owner.id)
      .map((userId) => ({
        userId,
        title: notificationTitle('auth.recovery_requested', opts.locale, { ref: requestId }),
        assignmentState: 'assigned' as const,
      })),
    { userId: owner.id, title: notificationTitle('auth.recovery_requested.self', opts.locale, { ref: '' }), assignmentState: null },
  ];
  const inserted = await tx
    .insert(notifications)
    .values(rows.map((r) => ({ ...r, eventId: event.id, type: event.type, materialId: null, priority: 'important' })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.eventId] })
    .returning({ id: notifications.id });
  return inserted.length;
}

async function systemAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, 'system_admin'), eq(users.status, 'active')));
  return rows.map((r) => r.userId);
}
