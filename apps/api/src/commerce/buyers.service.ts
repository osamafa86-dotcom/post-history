import { hash } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { buyerOrganizations, recoveryRequests, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { audit } from '../identity/recovery-approval';
import { RESET_TOKEN_DELIVERY, type ResetTokenDelivery } from '../identity/reset-token-delivery';
import { iso } from '../materials/material-store';
import { validTimestamp } from '../uploads/uploads.service';

export type BuyerOrganization = components['schemas']['BuyerOrganization'];
export type BuyerOrganizationCreate = components['schemas']['BuyerOrganizationCreate'];
export type BuyerOrganizationInput = components['schemas']['BuyerOrganizationInput'];
export type BuyerMember = components['schemas']['BuyerMember'];
type InviteToken = components['schemas']['BuyerInviteToken'];
export type BuyerMemberInvite = components['schemas']['BuyerMemberInvite'];
export type BuyerMemberUpdate = components['schemas']['BuyerMemberUpdate'];
type OrgRow = typeof buyerOrganizations.$inferSelect;
type Status = components['schemas']['BuyerOrganizationStatus'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUYER_ROLES = ['buyer_admin', 'buyer_member'] as const;

/**
 * مؤسسات المشترين وأعضاؤها (العقد v0.3، الجزء 3، ADR 0025). المؤسسة حساب مستقل: أعضاؤها يرون مؤسستهم وحدها، وأي
 * مؤسسة أخرى 404 بشكل المفقود (عزل المستأجرين). الحساب يُنشأ بلا كلمة مرور معروفة، ويُدعى برمز تعيين لمرة واحدة بمسار
 * الاستعادة نفسه (طلب معتمد، 24 ساعة، يُخزَّن ببصمته)، ثم يسجّل TOTP عند أول دخول. المقاعد تُفرض عند الدعوة تحت قفل صف
 * المؤسسة، ولا تبقى مؤسسة فعّالة بلا مدير. ETag وقت آخر تحديث بالميكروثانية.
 */
@Injectable()
export class BuyersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(RESET_TOKEN_DELIVERY) private readonly delivery: ResetTokenDelivery,
  ) {}

  async list(q: { status?: Status; cursor?: string; limit?: number }): Promise<{ items: BuyerOrganization[]; next_cursor: string | null }> {
    const limit = q.limit ?? 50;
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db
      .select({ org: buyerOrganizations, at: sql<string>`${buyerOrganizations.createdAt}::text` })
      .from(buyerOrganizations)
      .where(
        and(
          q.status ? eq(buyerOrganizations.status, q.status) : undefined,
          after ? sql`(${buyerOrganizations.createdAt}, ${buyerOrganizations.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(buyerOrganizations.createdAt), desc(buyerOrganizations.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const active = await activeCounts(this.db, page.map((r) => r.org.id));
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDto(r.org, active.get(r.org.id) ?? 0)),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.at, last.org.id])).toString('base64url') : null,
    };
  }

  async create(actorId: string, input: BuyerOrganizationCreate): Promise<{ org: BuyerOrganization & InviteToken; etag: string }> {
    if (input.status !== undefined && input.status !== 'pending_verification') throw ApiError.validation({ fields: ['/status'] });
    const passwordHash = await hash(randomToken(32));
    const token = randomToken(32);
    const created = await this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(buyerOrganizations)
        .values({
          legalName: input.legal_name,
          displayNameAr: input.display_name.ar,
          displayNameEn: input.display_name.en,
          country: input.country,
          billingEmail: input.billing_email,
          seats: input.seats ?? 5,
        })
        .returning();
      const admin = await this.createMember(tx, org!.id, actorId, input.first_admin_email, 'buyer_admin', passwordHash, token);
      await audit(tx, actorId, 'buyer_organization.created', admin.userId, { organization_id: org!.id, target_user_id: admin.userId, role: 'buyer_admin' });
      return { org: org!, admin };
    });
    const invite = await this.handOver(token, created.admin);
    const { org, etag } = await this.read(this.db, created.org.id);
    return { org: { ...org, ...invite }, etag };
  }

  async get(p: Principal, id: string): Promise<{ org: BuyerOrganization; etag: string }> {
    this.assertVisible(p, id);
    return this.read(this.db, id);
  }

  async replace(p: Principal, id: string, input: BuyerOrganizationInput, ifMatch: string | undefined): Promise<{ org: BuyerOrganization; etag: string }> {
    this.assertVisible(p, id);
    const admin = hasRole(p, 'system_admin');
    return this.db.transaction(async (tx) => {
      const [org] = await tx.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, id)).for('update');
      if (!org) throw ApiError.notFound();
      if (ifMatch !== undefined && ifMatch.trim() !== (await etagOf(tx, id))) {
        throw new ApiError(412, 'precondition_failed', 'The resource has changed; read it again and retry.');
      }
      const status = input.status ?? org.status;
      const seats = input.seats ?? org.seats;
      // الحالة والمقاعد لمدير النظام وحده؛ مدير المؤسسة يعدّل ملفها
      if (!admin && (status !== org.status || seats !== org.seats)) {
        throw new ApiError(403, 'forbidden_role', 'Only a system administrator changes the organization status or seats.');
      }
      const activating = status === 'active' && org.verifiedAt === null;
      await tx
        .update(buyerOrganizations)
        .set({
          legalName: input.legal_name,
          displayNameAr: input.display_name.ar,
          displayNameEn: input.display_name.en,
          country: input.country,
          billingEmail: input.billing_email,
          seats,
          status,
          ...(activating ? { verifiedAt: sql`now()`, verifiedBy: p.userId } : {}),
        })
        .where(eq(buyerOrganizations.id, id));
      if (status !== org.status) {
        await audit(tx, p.userId, 'buyer_organization.status_changed', p.userId, { organization_id: id, from: org.status, to: status });
      }
      return this.read(tx, id);
    });
  }

  async members(p: Principal, orgId: string): Promise<{ items: BuyerMember[] }> {
    this.assertVisible(p, orgId);
    if (!(await this.exists(this.db, orgId))) throw ApiError.notFound();
    const rows = await memberRows(this.db, orgId);
    return { items: rows.map(toMember) };
  }

  async invite(p: Principal, orgId: string, input: BuyerMemberInvite): Promise<BuyerMember & InviteToken> {
    this.assertVisible(p, orgId);
    const passwordHash = await hash(randomToken(32));
    const token = randomToken(32);
    const member = await this.db.transaction(async (tx) => {
      // قفل المؤسسة يسلسل الدعوات، فلا تتجاوز دعوتان متزامنتان حد المقاعد
      const [org] = await tx.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, orgId)).for('update');
      if (!org) throw ApiError.notFound();
      const [{ n }] = (await tx.select({ n: count() }).from(users).where(and(eq(users.organizationId, orgId), ne(users.status, 'suspended')))) as [{ n: number }];
      if (n >= org.seats) throw new ApiError(409, 'seats_exhausted', 'The organization has no free seat.');
      const created = await this.createMember(tx, orgId, p.userId, input.email, input.role, passwordHash, token);
      await audit(tx, p.userId, 'buyer_member.invited', created.userId, { organization_id: orgId, target_user_id: created.userId, role: input.role });
      return created;
    });
    const invite = await this.handOver(token, member);
    const [row] = (await memberRows(this.db, orgId)).filter((m) => m.id === member.userId);
    return { ...toMember(row!), ...invite };
  }

  async updateMember(p: Principal, orgId: string, userId: string, input: BuyerMemberUpdate): Promise<BuyerMember> {
    this.assertVisible(p, orgId);
    if (!UUID.test(userId)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [org] = await tx.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, orgId)).for('update');
      if (!org) throw ApiError.notFound();
      const [current] = (await memberRows(tx, orgId)).filter((m) => m.id === userId);
      if (!current) throw ApiError.notFound();
      const reactivating = current.status === 'suspended' && input.status === 'active';
      if (reactivating) {
        const [{ n }] = (await tx.select({ n: count() }).from(users).where(and(eq(users.organizationId, orgId), ne(users.status, 'suspended')))) as [{ n: number }];
        if (n >= org.seats) throw new ApiError(409, 'seats_exhausted', 'The organization has no free seat.');
      }
      await tx
        .update(userRoles)
        .set({ role: input.role })
        .where(and(eq(userRoles.userId, userId), inArray(userRoles.role, [...BUYER_ROLES])));
      if (input.status !== (current.status === 'suspended' ? 'suspended' : 'active')) {
        await tx.update(users).set({ status: input.status }).where(eq(users.id, userId));
      }
      // لا تبقى مؤسسة فعّالة بلا مدير نشط
      if (org.status === 'active') {
        const admins = (await memberRows(tx, orgId)).filter((m) => m.role === 'buyer_admin' && m.status !== 'suspended');
        if (admins.length === 0) throw new ApiError(409, 'last_buyer_admin', 'An active organization keeps at least one active buyer administrator.');
      }
      if (input.role !== current.role) {
        await audit(tx, p.userId, 'buyer_member.role_changed', userId, { organization_id: orgId, target_user_id: userId, from: current.role, to: input.role });
      }
      if (input.status !== (current.status === 'suspended' ? 'suspended' : 'active')) {
        await audit(tx, p.userId, 'buyer_member.status_changed', userId, { organization_id: orgId, target_user_id: userId, to: input.status });
      }
    });
    const [row] = (await memberRows(this.db, orgId)).filter((m) => m.id === userId);
    return toMember(row!);
  }

  /** المشتري يرى مؤسسته وحدها؛ غيرها 404 بشكل المفقود قبل أي بحث. الطاقم بدوره المسموح في x-roles. */
  private assertVisible(p: Principal, orgId: string): void {
    if (!UUID.test(orgId)) throw ApiError.notFound();
    const buyer = p.roles.some((r) => (BUYER_ROLES as readonly string[]).includes(r.role));
    if (buyer && p.organizationId !== orgId) throw ApiError.notFound();
  }

  private async exists(executor: Executor, id: string): Promise<boolean> {
    const [o] = await executor.select({ id: buyerOrganizations.id }).from(buyerOrganizations).where(eq(buyerOrganizations.id, id));
    return Boolean(o);
  }

  private async read(executor: Executor, id: string): Promise<{ org: BuyerOrganization; etag: string }> {
    const [org] = await executor.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, id));
    if (!org) throw ApiError.notFound();
    const active = await activeCounts(executor, [id]);
    return { org: toDto(org, active.get(id) ?? 0), etag: await etagOf(executor, id) };
  }

  /** حساب المشتري: كلمة سر لا يعرفها أحد، ودور بنطاق مؤسسته، وطلب استعادة معتمد برمز تعيين لمرة واحدة (24 ساعة). */
  private async createMember(
    tx: Tx,
    orgId: string,
    actorId: string,
    email: string,
    role: (typeof BUYER_ROLES)[number],
    passwordHash: string,
    token: string,
  ): Promise<{ userId: string; recoveryRequestId: string; expiresAt: string }> {
    let userId: string;
    try {
      // نقطة حفظ: تعارض البريد يُرد 409 دون أن يُفسد معاملة المؤسسة
      userId = await tx.transaction(async (sp) => {
        const [u] = await sp
          .insert(users)
          .values({ email, passwordHash, status: 'active', organizationId: orgId, credentialResetRequired: true })
          .returning({ id: users.id });
        return u!.id;
      });
    } catch (err) {
      // البريد المستعمل لحساب آخر، بلا تفريق بين طاقم ومشترٍ
      if (pgError(err).constraint === 'users_email_lower_key') throw new ApiError(409, 'bad_request', 'An account with this email exists.', { fields: ['/email'] });
      throw err;
    }
    await tx.insert(userRoles).values({ userId, role, scopeKind: 'organization', scopeId: orgId, grantedBy: actorId });
    const [request] = await tx
      .insert(recoveryRequests)
      .values({
        userId,
        state: 'approved',
        approvedBy: actorId,
        verificationNote: 'buyer invitation',
        decidedAt: sql`now()`,
        expiresAt: sql`now() + interval '24 hours'`,
        resetTokenHash: sha256(token),
        resetTokenExpiresAt: sql`now() + interval '24 hours'`,
      })
      .returning({ id: recoveryRequests.id, expiresAt: recoveryRequests.resetTokenExpiresAt });
    return { userId, recoveryRequestId: request!.id, expiresAt: iso(request!.expiresAt)! };
  }

  /**
   * الرمز يُسلَّم بقناة التسليم المحقونة كرمز الاستعادة، وإلا يُعاد مرة في الرد للمنشئ (ولا يُحفظ في جدول منع التكرار،
   * withoutTokens). لا يُسجَّل ولا يُكتب في Outbox.
   */
  private async handOver(token: string, member: { userId: string; recoveryRequestId: string; expiresAt: string }): Promise<InviteToken> {
    const delivered = await this.delivery.deliver({ token, expiresAt: member.expiresAt, targetUserId: member.userId, recoveryRequestId: member.recoveryRequestId });
    return delivered ? {} : { invite_token: token, invite_token_expires_at: member.expiresAt };
  }
}

async function etagOf(executor: Executor, id: string): Promise<string> {
  const [r] = await executor
    .select({ v: sql<string>`(extract(epoch from ${buyerOrganizations.updatedAt}) * 1000000)::bigint::text` })
    .from(buyerOrganizations)
    .where(eq(buyerOrganizations.id, id));
  return `"${r?.v ?? '0'}"`;
}

async function activeCounts(executor: Executor, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await executor
    .select({ org: users.organizationId, n: count() })
    .from(users)
    .where(and(inArray(users.organizationId, ids), eq(users.status, 'active'), eq(users.credentialResetRequired, false)))
    .groupBy(users.organizationId);
  return new Map(rows.map((r) => [r.org!, Number(r.n)]));
}

interface MemberRow {
  id: string;
  email: string;
  role: string;
  status: 'invited' | 'active' | 'suspended';
  totpEnabled: boolean;
  createdAt: string;
}

async function memberRows(executor: Executor, orgId: string): Promise<MemberRow[]> {
  const rows = await executor
    .select({
      id: users.id,
      email: users.email,
      role: userRoles.role,
      userStatus: users.status,
      lastLoginAt: users.lastLoginAt,
      resetRequired: users.credentialResetRequired,
      totpEnabled: users.totpEnabled,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), inArray(userRoles.role, [...BUYER_ROLES])))
    .where(eq(users.organizationId, orgId))
    .orderBy(users.createdAt, users.id);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    // المدعو لم يعيّن كلمته بعد؛ المعلّق بحالة حسابه
    status: r.userStatus === 'suspended' ? 'suspended' : r.resetRequired && r.lastLoginAt === null ? 'invited' : 'active',
    totpEnabled: r.totpEnabled,
    createdAt: r.createdAt,
  }));
}

function toMember(r: MemberRow): BuyerMember {
  return { user_id: r.id, email: r.email, role: r.role as BuyerMember['role'], status: r.status, totp_enabled: r.totpEnabled, created_at: iso(r.createdAt)! };
}

function toDto(o: OrgRow, activeMembers: number): BuyerOrganization {
  return {
    id: o.id,
    legal_name: o.legalName,
    display_name: { ar: o.displayNameAr, en: o.displayNameEn },
    country: o.country,
    billing_email: o.billingEmail,
    seats: o.seats,
    status: o.status as Status,
    active_members: activeMembers,
    verified_at: iso(o.verifiedAt),
    created_at: iso(o.createdAt)!,
    updated_at: iso(o.updatedAt)!,
  };
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at === 'string' && validTimestamp(at) && typeof id === 'string' && UUID.test(id)) return { at, id };
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}
