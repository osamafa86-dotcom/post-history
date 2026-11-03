import { Body, Controller, Get, Inject, Injectable, Param, Put, Req } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { auditLog, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { writeOutboxEvent } from '../outbox/outbox';
import { type Principal, type RoleName, Roles } from './principal';

type StaffRoles = components['schemas']['StaffRoles'];
type StaffRolesUpdate = components['schemas']['StaffRolesUpdate'];
type Role = components['schemas']['Role'];
type Grant = { role: string; scopeKind: string; scopeId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** أدوار الطاقم التي تُغيَّر من هنا؛ system_admin بإجراء الشخصين وحده، وأدوار المشترين في المؤسسات. */
const EDITABLE_ROLES: ReadonlySet<string> = new Set<RoleName>(['editor_in_chief', 'supervisor', 'producer', 'finance', 'reporter', 'rights_officer']);

/**
 * أدوار حساب الطاقم (A1، ADR 0104). الاستبدال كامل في معاملة واحدة مع حدث user.roles_changed بمعرّف الحساب وحده وتدقيق
 * برموز الأدوار قبل وبعد. system_admin خارج هذه النقطة في الاتجاهين (403 admin_quorum_required)، والمدير لا يغيّر أدواره.
 * الأدوار تُحمَّل مع كل طلب (loadPrincipal)، فيسري التغيير على الطلب التالي بلا إبطال للجلسات.
 */
@Injectable()
export class UserRolesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async get(userId: string): Promise<StaffRoles> {
    if (!UUID.test(userId)) throw ApiError.notFound();
    await staffAccount(this.db, userId);
    return { user_id: userId, roles: toRoles(await grantsOf(this.db, userId)) };
  }

  async replace(p: Principal, userId: string, body: StaffRolesUpdate): Promise<StaffRoles> {
    if (!UUID.test(userId)) throw ApiError.notFound();
    if (userId === p.userId) throw new ApiError(403, 'forbidden_scope', 'An administrator cannot change the roles of their own account.');
    if (body.roles.some((r) => r.name === 'system_admin')) throw adminQuorumRequired();
    const wanted = await this.validated(body.roles);
    return this.db.transaction(async (tx) => {
      // صف الحساب مقفول، فيتسلسل تغييران متزامنان
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      await staffAccount(tx, userId);
      const current = await grantsOf(tx, userId);
      // حساب مدير النظام لا يُمس من هنا: تنزيله يُنقص النصاب، فلا تسقط من هنا آخر مدير ولا غيره (ADR 0005، 0030)
      if (current.some((g) => g.role === 'system_admin')) throw adminQuorumRequired();
      const before = codes(current);
      const after = codes(wanted);
      if (before.join('|') === after.join('|')) return { user_id: userId, roles: toRoles(current) };
      await tx.delete(userRoles).where(eq(userRoles.userId, userId));
      await tx.insert(userRoles).values(wanted.map((g) => ({ userId, role: g.role, scopeKind: g.scopeKind, scopeId: g.scopeId, grantedBy: p.userId })));
      await writeOutboxEvent(tx, {
        type: 'user.roles_changed',
        aggregateType: 'user',
        aggregateId: userId,
        idempotencyKey: `user.roles_changed:${userId}:${randomUUID()}`,
        actorId: p.userId,
        payload: { user_id: userId },
      });
      await tx.insert(auditLog).values({
        actorId: p.userId,
        action: 'user.roles_changed',
        targetType: 'user',
        targetId: userId,
        details: { target_user_id: userId, from: before, to: after },
        hash: Buffer.alloc(32),
      });
      return { user_id: userId, roles: toRoles(await grantsOf(tx, userId)) };
    });
  }

  /**
   * الجسم بعد التحقق من العقد: دور طاقم مرة واحدة، والنطاق للمشرف وحده (مكتب موجود أو محافظة مكتب موجود)، والمشرف بلا
   * نطاق يرى الكل. الخطأ 422 بمسار الحقل.
   */
  private async validated(roles: Role[]): Promise<Grant[]> {
    const fields: string[] = [];
    const seen = new Set<string>();
    const grants: Grant[] = [];
    const officeIds = new Set<string>();
    const governorates = new Set<string>();
    roles.forEach((r, i) => {
      if (!EDITABLE_ROLES.has(r.name) || seen.has(r.name)) fields.push(`/roles/${i}/name`);
      seen.add(r.name);
      if (r.scopes.length > 0 && r.name !== 'supervisor') fields.push(`/roles/${i}/scopes`);
      const scopeKeys = new Set<string>();
      r.scopes.forEach((s, j) => {
        const key = `${s.kind}:${s.id}`;
        if ((s.kind !== 'office' && s.kind !== 'governorate') || scopeKeys.has(key) || (s.kind === 'office' && !UUID.test(s.id))) {
          fields.push(`/roles/${i}/scopes/${j}`);
        } else if (s.kind === 'office') officeIds.add(s.id.toLowerCase());
        else governorates.add(s.id);
        scopeKeys.add(key);
      });
      if (r.scopes.length === 0) grants.push({ role: r.name, scopeKind: 'all', scopeId: '' });
      else for (const s of r.scopes) grants.push({ role: r.name, scopeKind: s.kind, scopeId: s.kind === 'office' ? s.id.toLowerCase() : s.id });
    });
    if (fields.length === 0 && (officeIds.size > 0 || governorates.size > 0)) {
      const known = await this.db.execute<{ id: string; governorate: string }>(sql`SELECT id::text AS id, governorate FROM offices`);
      const ids = new Set(known.rows.map((o) => o.id));
      const govs = new Set(known.rows.map((o) => o.governorate));
      roles.forEach((r, i) =>
        r.scopes.forEach((s, j) => {
          if ((s.kind === 'office' && !ids.has(s.id.toLowerCase())) || (s.kind === 'governorate' && !govs.has(s.id))) fields.push(`/roles/${i}/scopes/${j}/id`);
        }),
      );
    }
    if (fields.length > 0) throw ApiError.validation({ fields: [...new Set(fields)] });
    return grants;
  }
}

/** حساب طاقم موجود (لا مشترٍ)؛ وإلا 404. */
async function staffAccount(executor: Executor, userId: string): Promise<void> {
  const [u] = await executor.select({ org: users.organizationId }).from(users).where(eq(users.id, userId));
  if (!u || u.org !== null) throw ApiError.notFound();
}

async function grantsOf(executor: Executor, userId: string): Promise<Grant[]> {
  return executor
    .select({ role: userRoles.role, scopeKind: userRoles.scopeKind, scopeId: userRoles.scopeId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
}

/** رموز الأدوار للتدقيق والمقارنة، مرتّبة: الدور، أو `الدور:النوع:المعرّف` للنطاق. لا اسم ولا بريد. */
function codes(grants: Grant[]): string[] {
  return grants.map((g) => (g.scopeKind === 'all' ? g.role : `${g.role}:${g.scopeKind}:${g.scopeId}`)).sort();
}

function toRoles(grants: Grant[]): Role[] {
  const byRole = new Map<string, Role>();
  for (const g of [...grants].sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : a.scopeId < b.scopeId ? -1 : 1))) {
    const r = byRole.get(g.role) ?? { name: g.role as RoleName, scopes: [] };
    if (g.scopeKind !== 'all') r.scopes.push({ kind: g.scopeKind as 'office' | 'governorate', id: g.scopeId });
    byRole.set(g.role, r);
  }
  return [...byRole.values()];
}

const adminQuorumRequired = () =>
  new ApiError(403, 'admin_quorum_required', 'A system administrator role is granted or removed only by the two-person procedure.');

@Controller('users')
export class UserRolesController {
  constructor(private readonly roles: UserRolesService) {}

  @Get(':id/roles')
  @Roles('system_admin')
  get(@Param('id') id: string): Promise<StaffRoles> {
    return this.roles.get(id);
  }

  @Put(':id/roles')
  @Roles('system_admin')
  replace(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<StaffRoles> {
    return this.roles.replace(req.principal!, id, validateBody<StaffRolesUpdate>('/users/{id}/roles', 'put', body));
  }
}
