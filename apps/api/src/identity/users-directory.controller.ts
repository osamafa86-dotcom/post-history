import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import type { components } from '../generated/api';
import { type RoleName, Roles } from './principal';

type StaffUserPage = components['schemas']['StaffUserPage'];
type StaffUserStatus = components['schemas']['StaffUserStatus'];
type Query = { role?: RoleName[]; status?: StaffUserStatus; q?: string; cursor?: string; limit?: number };

/**
 * حسابات الطاقم لمدير النظام (A1، ADR 0099): ما يعرضه الإطار وحده، اسم العمل والأدوار ومحافظة المكتب والحالة وآخر نشاط.
 * البريد يُبحث فيه ولا يُعاد، ولا اسم حقيقي ولا جهاز ولا موقع. حسابات المشترين خارجها (المؤسسات المشترية).
 */
@Injectable()
export class UsersDirectoryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(q: Query): Promise<StaffUserPage> {
    const limit = q.limit ?? 50;
    const where: SQL[] = [sql`u.organization_id IS NULL`];
    if (q.role?.length) {
      where.push(sql`EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role IN (${sql.join(q.role.map((r) => sql`${r}`), sql`, `)}))`);
    }
    if (q.status) where.push(sql`u.status = ${q.status}`);
    if (q.q !== undefined) where.push(sql`(strpos(lower(coalesce(u.work_name, '')), lower(${q.q}::text)) > 0 OR strpos(lower(u.email), lower(${q.q}::text)) > 0)`);
    if (q.cursor !== undefined) {
      const c = decodeCursor(q.cursor);
      where.push(sql`(u.created_at, u.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const { rows } = await this.db.execute<{
      id: string; work_name: string | null; status: StaffUserStatus; created_at: string; governorate: string | null; roles: RoleName[] | null; last_active_at: string | null;
    }>(sql`
      SELECT u.id, u.work_name, u.status, u.created_at::text AS created_at, o.governorate,
             (SELECT array_agg(DISTINCT r.role ORDER BY r.role) FROM user_roles r WHERE r.user_id = u.id) AS roles,
             greatest(u.last_login_at, (SELECT max(t.last_seen_at) FROM refresh_tokens t WHERE t.user_id = u.id)) AS last_active_at
      FROM users u LEFT JOIN offices o ON o.id = u.office_id
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id,
        work_name: r.work_name,
        roles: r.roles ?? [],
        governorate: r.governorate,
        status: r.status,
        last_active_at: r.last_active_at === null ? null : new Date(r.last_active_at).toISOString(),
      })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url') : null,
      summary: await this.summary(),
    };
  }

  private async summary(): Promise<StaffUserPage['summary']> {
    const [counts] = (await this.db.execute<{ total: number; suspended: number }>(sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'suspended')::int AS suspended
      FROM users WHERE organization_id IS NULL`)).rows;
    const { rows } = await this.db.execute<{ role: RoleName; count: number }>(sql`
      SELECT r.role, count(DISTINCT r.user_id)::int AS count
      FROM user_roles r JOIN users u ON u.id = r.user_id AND u.organization_id IS NULL
      GROUP BY r.role ORDER BY r.role`);
    return { total: counts?.total ?? 0, suspended: counts?.suspended ?? 0, roles: rows.map((r) => ({ role: r.role, count: Number(r.count) })) };
  }
}

@Controller('users')
export class UsersDirectoryController {
  constructor(private readonly users: UsersDirectoryService) {}

  @Get()
  @Roles('system_admin')
  list(@Query() query: Record<string, unknown>): Promise<StaffUserPage> {
    // role يتكرر في العقد (explode)؛ القيمة الواحدة تصل نصًّا من Express فتُلفّ مصفوفة قبل التحقق
    const q = typeof query.role === 'string' ? { ...query, role: [query.role] } : query;
    return this.users.list(validateQuery<Query>('/users', 'get', q));
  }
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    // الوقت بدقته الكاملة نصًّا من القاعدة (created_at::text)، فلا يسقط جزء الميكروثانية بين صفحتين
    if (typeof at === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]{8,15}[+-][0-9:]{2,5}$/.test(at) && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return { at, id };
  } catch {
    // يقع إلى الخطأ أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}
