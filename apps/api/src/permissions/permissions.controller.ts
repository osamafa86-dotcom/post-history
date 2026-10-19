import { Body, Controller, Delete, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { userPermissions, users } from '../database/schema/schema';
import { type Permission, Roles } from '../identity/principal';

const PERMISSIONS: readonly Permission[] = ['sensitive_location:read', 'protected_source:read'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * الصلاحيتان المستقلتان (ADR SEC-03): تُمنحان لمستخدم بعينه لا لدور، ولا تُمنحان تلقائيًا حتى لمدير النظام.
 * المنح والسحب ذاتيا التكرار؛ محفّز القاعدة يكتب كلًّا منهما في audit_log، والسبب في سجل الصلاحيات لا في التدقيق.
 * السحب يسري عند الطلب التالي لأن الصلاحيات تُقرأ مع كل طلب.
 */
@Controller('users/:id/permissions')
export class PermissionsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Put(':permission')
  @HttpCode(204)
  @Roles('system_admin')
  async grant(@Param('id') userId: string, @Param('permission') permission: string, @Body() body: unknown, @Req() req: Request): Promise<void> {
    if (!PERMISSIONS.includes(permission as Permission)) throw ApiError.validation({ fields: ['path:permission'] });
    const { reason } = validateBody<{ reason: string }>('/users/{id}/permissions/{permission}', 'put', body);
    await this.assertUser(userId);
    await this.db.execute(sql`
      INSERT INTO user_permissions (user_id, permission, granted_by, reason)
      VALUES (${userId}::uuid, ${permission}, ${req.auth!.userId}::uuid, ${reason})
      ON CONFLICT (user_id, permission) WHERE revoked_at IS NULL DO NOTHING`);
  }

  @Delete(':permission')
  @HttpCode(204)
  @Roles('system_admin')
  async revoke(@Param('id') userId: string, @Param('permission') permission: string, @Req() req: Request): Promise<void> {
    if (!PERMISSIONS.includes(permission as Permission)) throw ApiError.notFound();
    await this.assertUser(userId);
    await this.db
      .update(userPermissions)
      .set({ revokedAt: sql`now()`, revokedBy: req.auth!.userId })
      .where(and(eq(userPermissions.userId, userId), eq(userPermissions.permission, permission), isNull(userPermissions.revokedAt)));
  }

  private async assertUser(id: string): Promise<void> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!user) throw ApiError.notFound();
  }
}
