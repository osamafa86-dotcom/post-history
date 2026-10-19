import { SetMetadata } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { userPermissions, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';

export type RoleName = components['schemas']['RoleName'];
export type Permission = components['schemas']['Permission'];

export interface RoleGrant {
  role: RoleName;
  scopeKind: 'all' | 'office' | 'governorate';
  scopeId: string;
}

/** المستخدم المصادَق بأدواره ونطاقاتها وصلاحياته المستقلة النشطة؛ يُحمَّل مرة لكل طلب. */
export interface Principal {
  userId: string;
  officeId: string | null;
  roles: RoleGrant[];
  permissions: ReadonlySet<Permission>;
}

export function hasRole(p: Principal, ...roles: RoleName[]): boolean {
  return p.roles.some((r) => roles.includes(r.role));
}

export async function loadPrincipal(db: Executor, userId: string): Promise<Principal> {
  const [user] = await db.select({ officeId: users.officeId }).from(users).where(eq(users.id, userId));
  const roles = await db
    .select({ role: userRoles.role, scopeKind: userRoles.scopeKind, scopeId: userRoles.scopeId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  const perms = await db
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(and(eq(userPermissions.userId, userId), isNull(userPermissions.revokedAt)));
  return {
    userId,
    officeId: user?.officeId ?? null,
    roles: roles as RoleGrant[],
    permissions: new Set(perms.map((p) => p.permission as Permission)),
  };
}

export const ROLES_KEY = 'auth:roles';
/**
 * الأدوار المسموح لها بالعملية كما في `x-roles` بالعقد؛ 'authenticated' = أي جلسة صالحة.
 * الدور غير المدرج يُرفض بـ 403 قبل أي بحث عن المورد (فلا يُستدل على وجوده).
 */
export const Roles = (...roles: Array<RoleName | 'authenticated'>) => SetMetadata(ROLES_KEY, roles);

declare module 'express' {
  interface Request {
    principal?: Principal;
  }
}

/** هل يغطي مشرفٌ هذا المستخدم (كل شيء، أو مكتبه، أو محافظة مكتبه)؟ لإبطال جلساته واعتماد استعادته. */
export function supervisesUser(p: Principal, user: { officeId: string | null; governorate: string | null }): boolean {
  return p.roles.some(
    (r) =>
      r.role === 'supervisor' &&
      (r.scopeKind === 'all' ||
        (r.scopeKind === 'office' && user.officeId !== null && r.scopeId === user.officeId) ||
        (r.scopeKind === 'governorate' && user.governorate !== null && r.scopeId === user.governorate)),
  );
}

/** رتبة الدور في تسلسل الطاقم: الأدوار التنفيذية في القاع، ثم المشرف، ثم رئيس التحرير، ثم مدير النظام. */
const ROLE_RANK: Record<RoleName, number> = {
  reporter: 1,
  producer: 1,
  finance: 1,
  rights_officer: 1,
  supervisor: 2,
  editor_in_chief: 3,
  system_admin: 4,
};

export function highestRank(roles: readonly RoleName[]): number {
  return roles.reduce((max, r) => Math.max(max, ROLE_RANK[r] ?? 0), 0);
}

/**
 * قاعدة التسلسل في إبطال جلسات حساب آخر واعتماد استعادته، فوق مطابقة النطاق: لا أحد يقرر في حسابه هو؛ مدير النظام
 * يقرر في أي حساب آخر (ومنه حساب مدير نظام آخر)؛ وغيره يقرر فقط في حساب دوره الأعلى أدنى من دور المقرِّر الأعلى،
 * فالحساب المساوي (مشرف نظير) لمدير النظام وحده، منعًا للاستيلاء الأفقي.
 */
export function mayDecideFor(p: Principal, targetUserId: string, targetRoles: readonly RoleName[]): boolean {
  if (targetUserId === p.userId) return false;
  if (hasRole(p, 'system_admin')) return true;
  return highestRank(targetRoles) < highestRank(p.roles.map((r) => r.role));
}
