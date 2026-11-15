import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, Req } from '@nestjs/common';
import { asc, eq, or, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import { randomToken } from '../common/crypto';
import { ApiError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Database } from '../database/database.module';
import { offices, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hash } from '@node-rs/argon2';
import { pgError } from '../common/db-errors';
import { auditLog } from '../database/schema/schema';
import { type RoleName, Roles } from './principal';
import type { RateLimiter } from './rate-limiter';
import { RateLimitsService } from './rate-limits.service';
import { audit } from './recovery-approval';

type Office = components['schemas']['Office'];
type OfficeInput = components['schemas']['OfficeInput'];
type StaffAccountInput = components['schemas']['StaffAccountInput'];
type StaffUser = components['schemas']['StaffUser'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** نص يُعرض: بلا مسافة في طرفيه ولا محارف تحكم أو اتجاه (قاعدة اسم العمل نفسها). */
const displayText = (value: string) => value === value.trim() && !/[\u0000-\u001f\u007f‪-‮⁦-⁩]/.test(value);
const invalid = (field: string) => ApiError.validation({ fields: [`/${field}`] });
const rateLimited = (wait: number) => new ApiError(429, 'rate_limited', 'Too many attempts.', undefined, { 'Retry-After': String(wait) });
/** الأدوار التي ينشئها مدير النظام من الواجهة: الطاقم والمراسل. مدير النظام بإجراء الشخصين من سطر الأوامر، والمشتري بدعوة مؤسسته. */
const CREATABLE: readonly RoleName[] = ['editor_in_chief', 'supervisor', 'producer', 'finance', 'rights_officer', 'reporter'];

/**
 * إدارة الطاقم من الواجهة (ADR 0122): المكاتب، وإنشاء حساب بدور واحد. الحساب يولد بكلمة عشوائية لا تُعرض لأحد وفي «إعادة تعيين
 * إلزامية»، فلا دخول إليه حتى يصدر مدير النظام رابط إعادة التعيين القائم ويكمله صاحبه. لا طريق من هنا إلى دور مدير النظام. كل إنشاء
 * مدقَّق بلا بريد ولا اسم، وبحد معدل لكل مدير.
 */
@Injectable()
export class StaffManagementService {
  private readonly byAdmin: RateLimiter;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) config: AppConfig,
    limits: RateLimitsService,
  ) {
    this.byAdmin = limits.create('staff-management-admin', config.STAFF_CREATE_RATE_LIMIT_MAX);
  }

  async listOffices(): Promise<{ items: Office[] }> {
    const rows = await this.db.select().from(offices).orderBy(asc(offices.nameAr), asc(offices.id));
    return { items: rows.map(toOffice).sort((a, b) => a.name_ar.localeCompare(b.name_ar, 'ar')) };
  }

  async createOffice(adminId: string, input: OfficeInput): Promise<Office> {
    for (const field of ['name_ar', 'name_en', 'governorate'] as const) if (!displayText(input[field])) throw invalid(field);
    await this.spend(adminId);
    return this.db.transaction(async (tx) => {
      // إنشاءان متزامنان بالاسم نفسه: الثاني ينتظر ثم يرى الأول فيُرفض
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('offices:create'))`);
      const [taken] = await tx.select({ id: offices.id }).from(offices).where(or(eq(offices.nameAr, input.name_ar), eq(offices.nameEn, input.name_en))).limit(1);
      if (taken) throw new ApiError(409, 'office_exists', 'An office with this name exists.');
      const [row] = await tx.insert(offices).values({ nameAr: input.name_ar, nameEn: input.name_en, governorate: input.governorate }).returning();
      await auditOffice(tx, adminId, row!.id);
      return toOffice(row!);
    });
  }

  async createUser(adminId: string, input: StaffAccountInput): Promise<StaffUser> {
    const role = input.role as RoleName;
    // القائمة مغلقة في العقد؛ الفحص هنا يبقى ولو اتسع المخطط: لا مدير نظام ولا مشترٍ من هذا المسار
    if (!CREATABLE.includes(role)) throw invalid('role');
    const scopeKind = input.scope_kind ?? 'all';
    const scopeId = input.scope_id ?? '';
    const officeId = input.office_id ?? null;
    const workName = input.work_name ?? null;
    if (role !== 'supervisor' && scopeKind !== 'all') throw invalid('scope_kind');
    if ((scopeKind === 'all') !== (scopeId === '')) throw invalid('scope_id');
    if (scopeKind === 'office' && !UUID.test(scopeId)) throw invalid('scope_id');
    if (role === 'reporter' && !officeId) throw invalid('office_id');
    // اسم العمل للطاقم وحده (ADR 0035)
    if (role === 'reporter' && workName !== null) throw invalid('work_name');
    await this.spend(adminId);
    // كلمة لا تُعرض لأحد ولا تُسجَّل: الدخول بعد رابط إعادة التعيين وحده
    const passwordHash = await hash(randomToken(32));
    try {
      return await this.db.transaction(async (tx) => {
        const wanted = [...new Set([officeId, scopeKind === 'office' ? scopeId : null].filter((id): id is string => !!id))];
        const found = wanted.length ? await tx.select({ id: offices.id, governorate: offices.governorate }).from(offices).where(or(...wanted.map((id) => eq(offices.id, id)))) : [];
        if (officeId && !found.some((o) => o.id === officeId)) throw invalid('office_id');
        if (scopeKind === 'office' && !found.some((o) => o.id === scopeId)) throw invalid('scope_id');
        const [u] = await tx
          .insert(users)
          .values({ email: input.email, passwordHash, status: 'active', officeId, workName, credentialResetRequired: true })
          .returning({ id: users.id });
        await tx.insert(userRoles).values({ userId: u!.id, role, scopeKind, scopeId, grantedBy: adminId });
        await audit(tx, adminId, 'user.created', u!.id, { target_user_id: u!.id, role, scope_kind: scopeKind, scope_id: scopeId, reason_code: 'admin_ui' });
        return { id: u!.id, work_name: workName, roles: [role], governorate: found.find((o) => o.id === officeId)?.governorate ?? null, status: 'active' as const, last_active_at: null };
      });
    } catch (err) {
      if (pgError(err).constraint === 'users_email_lower_key') throw new ApiError(409, 'email_taken', 'An account with this email exists.');
      throw err;
    }
  }

  /** كل إنشاء (حساب أو مكتب) يُعد في حد المعدل لمديره، قبل أي كتابة. */
  private async spend(adminId: string): Promise<void> {
    const wait = await this.byAdmin.retryAfter(adminId);
    if (wait > 0) throw rateLimited(wait);
    await this.byAdmin.record(adminId);
  }
}

const toOffice = (row: typeof offices.$inferSelect): Office => ({ id: row.id, name_ar: row.nameAr, name_en: row.nameEn, governorate: row.governorate ?? '' });

/** تدقيق إنشاء المكتب: معرّفه في `scope_id` (مفاتيح القائمة البيضاء القائمة)، بلا اسمه. الهدف المكتب لا مستخدم. */
async function auditOffice(tx: Parameters<Parameters<Database['transaction']>[0]>[0], actorId: string, officeId: string): Promise<void> {
  await tx.insert(auditLog).values({ actorId, action: 'office.created', targetType: 'office', targetId: officeId, details: { scope_kind: 'office', scope_id: officeId }, hash: Buffer.alloc(32) });
}

@Controller()
export class StaffManagementController {
  constructor(private readonly staff: StaffManagementService) {}

  @Get('offices')
  @Roles('system_admin')
  listOffices(): Promise<{ items: Office[] }> {
    return this.staff.listOffices();
  }

  @Post('offices')
  @HttpCode(201)
  @Roles('system_admin')
  createOffice(@Body() body: unknown, @Req() req: Request): Promise<Office> {
    return this.staff.createOffice(req.principal!.userId, validateBody<OfficeInput>('/offices', 'post', body));
  }

  @Post('users')
  @HttpCode(201)
  @Roles('system_admin')
  createUser(@Body() body: unknown, @Req() req: Request): Promise<StaffUser> {
    return this.staff.createUser(req.principal!.userId, validateBody<StaffAccountInput>('/users', 'post', body));
  }
}
