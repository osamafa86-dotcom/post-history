import { sql, type SQL } from 'drizzle-orm';
import type { Principal } from '../identity/principal';

/** لا يظهر اسم العمل لمراسل أو مشترٍ، ولو اجتمع لديه دور آخر. */
export function maySeeWorkNames(p: Principal): boolean {
  return !p.organizationId && p.roles.length > 0 && !p.roles.some(r => ['reporter', 'buyer_admin', 'buyer_member'].includes(r.role));
}

/** دفاع مستقل عن قيد الإدخال: اسم طاقم فقط حتى لو وُجدت قيمة قديمة لحساب مراسل. */
export function staffWorkName(userId: SQL): SQL<string | null> {
  return sql<string | null>`(SELECT u.work_name FROM users u WHERE u.id = ${userId} AND u.organization_id IS NULL
    AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN ('reporter', 'buyer_admin', 'buyer_member')))`;
}

/** المادة نفسها مُرشَّحة بنطاق المستدعي قبل هذا الاستعلام المرتبط. */
export function acknowledgementDue(materialId: SQL): SQL<string | null> {
  return sql<string | null>`(SELECT min(n.escalate_at) FROM notifications n WHERE n.material_id = ${materialId}
    AND n.assignment_state = 'assigned' AND n.acknowledged_at IS NULL)`;
}

export function workNameFor(p: Principal, name: string | null | undefined): string | null {
  return maySeeWorkNames(p) ? name ?? null : null;
}
