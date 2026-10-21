import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Query, Req } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody, validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { userPermissions, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { type Permission, Roles } from '../identity/principal';

const PERMISSIONS: readonly Permission[] = ['sensitive_location:read', 'protected_source:read', 'reporter_identity:read'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * الصلاحيات المستقلة (ADR SEC-03، و`reporter_identity:read` في ADR 0021): تُمنح لمستخدم بعينه لا لدور، ولا تُمنح تلقائيًا
 * حتى لمدير النظام.
 * المنح والسحب ذاتيا التكرار؛ محفّز القاعدة يكتب كلًّا منهما في audit_log، والسبب في سجل الصلاحيات لا في التدقيق.
 * السحب يسري عند الطلب التالي لأن الصلاحيات تُقرأ مع كل طلب.
 */
@Controller('users/:id/permissions')
export class PermissionsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * سجل المنح والسحب لهذا المستخدم، وتغييرات `reporter_legal_name_access` (ADR 0021) لأنها تغيّر الصلاحية الفعّالة
   * للجميع، من audit_log الأحدث أولًا. المؤشر رقم آخر صف. معرّفات وأكواد فقط: سبب المنح الحر لا يُقرأ.
   */
  @Get('history')
  @Roles('system_admin')
  async history(@Param('id') userId: string, @Query() query: Record<string, unknown>): Promise<components['schemas']['PermissionHistoryPage']> {
    const q = validateQuery<{ cursor?: string; limit?: number }>('/users/{id}/permissions/history', 'get', query);
    if (q.cursor !== undefined && !/^[0-9]{1,19}$/.test(q.cursor)) throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
    await this.assertUser(userId);
    const limit = q.limit ?? 50;
    const before = q.cursor ? sql`AND id < ${q.cursor}::bigint` : sql``;
    const { rows } = await this.db.execute<{ id: string; action: string; actor_id: string | null; occurred_at: string; details: Record<string, string> }>(sql`
      (SELECT id, action, actor_id, occurred_at, details FROM audit_log
        WHERE target_type = 'user' AND target_id = ${userId} AND action IN ('permission.granted', 'permission.revoked') ${before}
        ORDER BY id DESC LIMIT ${limit + 1})
      UNION ALL
      (SELECT id, action, actor_id, occurred_at, details FROM audit_log
        WHERE target_type = 'setting' AND target_id = 'reporter_legal_name_access' AND action = 'setting.changed' ${before}
        ORDER BY id DESC LIMIT ${limit + 1})
      ORDER BY id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => {
        const setting = r.action === 'setting.changed';
        return {
          id: String(r.id),
          kind: setting ? 'setting_changed' : r.action === 'permission.granted' ? 'permission_granted' : 'permission_revoked',
          permission: setting ? null : (r.details.permission as Permission),
          setting: setting ? 'reporter_legal_name_access' : null,
          value: setting ? (r.details.value as components['schemas']['ReporterIdentityAccess']) : null,
          actor_id: r.actor_id,
          occurred_at: new Date(r.occurred_at).toISOString(),
          reason_code: setting ? (r.details.reason_code ?? null) : null,
        };
      }),
      next_cursor: rows.length > limit ? String(page[page.length - 1]!.id) : null,
    };
  }

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
