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
