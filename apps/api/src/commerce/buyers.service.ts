import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { randomToken, sha256 } from '../common/crypto';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { buyerInviteConflicts, buyerOrganizations, recoveryRequests, userRoles, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { audit, resetCredentials } from '../identity/recovery-approval';
import { revokeAllAccess } from '../identity/session.service';
import { RESET_TOKEN_DELIVERY, type ResetTokenDelivery } from '../identity/reset-token-delivery';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { validTimestamp } from '../uploads/uploads.service';

export type BuyerOrganization = components['schemas']['BuyerOrganization'];
export type BuyerOrganizationCreate = components['schemas']['BuyerOrganizationCreate'];
export type BuyerOrganizationInput = components['schemas']['BuyerOrganizationInput'];
export type BuyerOrganizationRejection = components['schemas']['BuyerOrganizationRejection'];
export type BuyerMember = components['schemas']['BuyerMember'];
type InviteToken = components['schemas']['BuyerInviteToken'];
export type BuyerMemberInvite = components['schemas']['BuyerMemberInvite'];
export type BuyerMemberUpdate = components['schemas']['BuyerMemberUpdate'];
type OrgRow = typeof buyerOrganizations.$inferSelect;
type Status = components['schemas']['BuyerOrganizationStatus'];
type RejectionReason = components['schemas']['BuyerOrganizationRejectionReason'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUYER_ROLES = ['buyer_admin', 'buyer_member'] as const;
type BuyerRole = (typeof BUYER_ROLES)[number];
/** ما صدر لمدعو: حساب حقيقي بطلب استعادة يحمل رمزه، أو تعارض لا رمز له يُسلَّم */
type Issued = { conflict: true; userId: string; expiresAt: string } | { conflict: false; userId: string; recoveryRequestId: string; expiresAt: string };

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
    const ids = page.map((r) => r.org.id);
    const [active, occupied] = await Promise.all([activeCounts(this.db, ids), occupiedCounts(this.db, ids)]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDto(r.org, active.get(r.org.id) ?? 0, occupied.get(r.org.id) ?? 0)),
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
      const seats = input.seats ?? org.seats;
      // الحالة والمقاعد لمدير النظام وحده؛ مدير المؤسسة يعدّل ملفها
      if (!admin && ((input.status ?? org.status) !== org.status || seats !== org.seats)) {
        throw new ApiError(403, 'forbidden_role', 'Only a system administrator changes the organization status or seats.');
      }
      // الاسم القانوني والبلد هما ما تحقق منه مدير النظام (ADR 0118): تغييرهما من مدير المؤسسة بعد التحقق يعيدها إلى
      // pending_verification ويمحو verified_at في المعاملة نفسها، والمعلّقة لا تغيّرهما. مدير النظام هو المتحقق فتعديله لا يعيدها
      const identityChanged = input.legal_name !== org.legalName || input.country !== org.country;
      if (!admin && identityChanged && org.status === 'suspended') {
        throw new ApiError(403, 'forbidden_role', 'A suspended organization cannot change its legal name or country.');
      }
      const reverify = !admin && identityChanged && org.status === 'active';
      const status = reverify ? 'pending_verification' : (input.status ?? org.status);
      // الرفض بسببه من /rejection وحده (ADR 0104)؛ PUT يُبقي المرفوضة أو يعيدها إلى غيرها فيُمحى السبب
      if (status === 'rejected' && org.status !== 'rejected') throw ApiError.validation({ fields: ['/status'] });
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
          ...(status !== 'rejected' ? { rejectionReason: null } : {}),
          ...(activating ? { verifiedAt: sql`now()`, verifiedBy: p.userId } : {}),
          ...(reverify ? { verifiedAt: null, verifiedBy: null } : {}),
        })
        .where(eq(buyerOrganizations.id, id));
      if (status !== org.status) await recordStatusChange(tx, p.userId, id, org.status as Status, status as Status, null);
      // بريد الفوترة يتغيّر بلا إعادة تحقق، ويُدقَّق بلا قيمته
      if (input.billing_email !== org.billingEmail) {
        await audit(tx, p.userId, 'buyer_organization.billing_email_changed', p.userId, { organization_id: id, reason_code: 'billing_email_changed' });
      }
      return this.read(tx, id);
    });
  }

  /**
   * رفض طلب انضمام مؤسسة قيد التحقق بسبب مرمّز (A5، ADR 0104): من pending_verification وحدها، في معاملة واحدة مع الحدث
   * والتدقيق. المرفوضة لا تتصفح ولا تشتري ولا تنزّل لأن كل بوّابة تشترط active.
   */
  async reject(p: Principal, id: string, reason: RejectionReason, ifMatch: string | undefined): Promise<{ org: BuyerOrganization; etag: string }> {
    if (!UUID.test(id)) throw ApiError.notFound();
    return this.db.transaction(async (tx) => {
      const [org] = await tx.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, id)).for('update');
      if (!org) throw ApiError.notFound();
      if (ifMatch !== undefined && ifMatch.trim() !== (await etagOf(tx, id))) {
        throw new ApiError(412, 'precondition_failed', 'The resource has changed; read it again and retry.');
      }
      if (org.status !== 'pending_verification') {
        throw new ApiError(409, 'invalid_transition', `Only an organization pending verification is rejected; this one is ${org.status}.`, {
          from: org.status,
          to: 'rejected',
        });
      }
      await tx.update(buyerOrganizations).set({ status: 'rejected', rejectionReason: reason }).where(eq(buyerOrganizations.id, id));
      await recordStatusChange(tx, p.userId, id, 'pending_verification', 'rejected', reason);
      return this.read(tx, id);
    });
  }

  async members(p: Principal, orgId: string): Promise<{ items: BuyerMember[] }> {
    this.assertVisible(p, orgId);
    if (!(await this.exists(this.db, orgId))) throw ApiError.notFound();
    const rows = await memberRows(this.db, orgId);
    return { items: rows.map(toMember) };
  }

  /**
   * دعوة عضو. البريد القائم لحساب خارج المؤسسة لا يُكشف (متابعة أمن #304): الرد بشكل الدعوة الناجحة وحالتها، والتعارض
   * يُحفظ عضوًا مدعوًّا في `buyer_invite_conflicts` يحسمه مدير النظام، فيظهر في القائمة ويشغل مقعدًا كأي مدعو. البريد
   * الذي لم يكتمل قبول دعوته في المؤسسة نفسها (مدعوًّا أو تعارضًا قائمًا) يُعاد إصدار رمزه بلا مقعد جديد، والذي أُلغيت دعوته
   * يُدعى من جديد بالمعرّف نفسه إن بقي مقعد (قرار المنسّق 2026-11-15)؛ والتعارض يسلك مسلك الحساب الحقيقي في الحالتين فلا
   * يفرّق بينهما رد. العضو الذي أكمل القبول، والمعلّق، يبقيان 409 لأن مدير المؤسسة يراهما في قائمتها أصلًا.
   */
  async invite(p: Principal, orgId: string, input: BuyerMemberInvite): Promise<BuyerMember & InviteToken> {
    this.assertVisible(p, orgId);
    const passwordHash = await hash(randomToken(32));
    const token = randomToken(32);
    const member = await this.db.transaction(async (tx): Promise<Issued> => {
      // قفل المؤسسة يسلسل الدعوات، فلا تتجاوز دعوتان متزامنتان حد المقاعد
      const [org] = await tx.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, orgId)).for('update');
      if (!org) throw ApiError.notFound();
      const taken = await existingAccount(tx, input.email);
      const rows = await memberRows(tx, orgId);
      const listed = taken
        ? rows.find((m) => (taken.organizationId === orgId ? m.id === taken.id : m.conflict && m.email.toLowerCase() === input.email.toLowerCase()))
        : undefined;
      if (listed?.status === 'invited') {
        const issued = await this.reissue(tx, p.userId, orgId, listed, token, input.role);
        if (org.status === 'active') assertAdminRemains(await memberRows(tx, orgId));
        return issued;
      }
      if ((await seatsTaken(tx, orgId)) >= org.seats) throw new ApiError(409, 'seats_exhausted', 'The organization has no free seat.');
      if (listed) throw emailTaken();
      if (taken?.organizationId === orgId) {
        // لا دور له في المؤسسة: دعوة أُلغيت قبل قبولها تعود بحسابها نفسه؛ وغيرها حساب قائم
        if (!taken.neverAccepted) throw emailTaken();
        await tx.insert(userRoles).values({ userId: taken.id, role: input.role, scopeKind: 'organization', scopeId: orgId, grantedBy: p.userId });
        await tx.update(users).set({ membershipSuspended: false }).where(eq(users.id, taken.id));
        const request = await this.issueToken(tx, taken.id, p.userId, token);
        await audit(tx, p.userId, 'buyer_member.invited', taken.id, { organization_id: orgId, target_user_id: taken.id, role: input.role });
        return { conflict: false, userId: taken.id, ...request };
      }
      if (taken) {
        // دعوة متعارضة أُلغيت تعود بمعرّفها نفسه كما يعود الحساب الحقيقي، وإلا فتعارض جديد
        const [closed] = await tx
          .select({ id: buyerInviteConflicts.id })
          .from(buyerInviteConflicts)
          .where(and(eq(buyerInviteConflicts.organizationId, orgId), sql`lower(${buyerInviteConflicts.email}) = lower(${input.email})`, eq(buyerInviteConflicts.state, 'dismissed')))
          .orderBy(desc(buyerInviteConflicts.resolvedAt))
          .limit(1);
        const values = { existingUserId: taken.id, role: input.role, invitedBy: p.userId, inviteExpiresAt: sql`now() + interval '24 hours'` };
        const [c] = closed
          ? await tx
              .update(buyerInviteConflicts)
              .set({ ...values, state: 'pending', resolvedAt: null, resolvedBy: null, updatedAt: sql`now()` })
              .where(eq(buyerInviteConflicts.id, closed.id))
              .returning({ id: buyerInviteConflicts.id, expiresAt: buyerInviteConflicts.inviteExpiresAt })
          : await tx
              .insert(buyerInviteConflicts)
              .values({ ...values, organizationId: orgId, email: input.email })
              .returning({ id: buyerInviteConflicts.id, expiresAt: buyerInviteConflicts.inviteExpiresAt });
        await audit(tx, p.userId, 'buyer_member.invite_conflict', taken.id, { organization_id: orgId, target_user_id: taken.id, conflict_id: c!.id, role: input.role });
        return { conflict: true, userId: c!.id, expiresAt: iso(c!.expiresAt)! };
      }
      const created = await this.createMember(tx, orgId, p.userId, input.email, input.role, passwordHash, token);
      await audit(tx, p.userId, 'buyer_member.invited', created.userId, { organization_id: orgId, target_user_id: created.userId, role: input.role });
      return { conflict: false, ...created };
    });
    return this.answer(orgId, token, member);
  }

  /**
   * إعادة إصدار رمز دعوة لم يكتمل قبولها (قرار المنسّق 2026-11-15): للمدعو وحده. الرمز السابق يبطل، ومن استعمله ولم يُكمل
   * ربط التحقق بخطوتين يبدأ من جديد بالرمز الجديد. لا مقعد إضافي.
   */
  async reissueInvitation(p: Principal, orgId: string, userId: string): Promise<BuyerMember & InviteToken> {
    this.assertVisible(p, orgId);
    if (!UUID.test(userId)) throw ApiError.notFound();
    const token = randomToken(32);
    const issued = await this.db.transaction(async (tx) => {
      const current = await this.invited(tx, orgId, userId, 'invited');
      return this.reissue(tx, p.userId, orgId, current.member, token);
    });
    return this.answer(orgId, token, issued);
  }

  /**
   * إلغاء دعوة لم يكتمل قبولها (قرار المنسّق 2026-11-15): رمزها يبطل ومقعدها يتحرر وتخرج من قائمة الأعضاء. الحساب الذي
   * لم يدخل قط يبقى بلا دور في المؤسسة وعضويته معلّقة، فلا يدخل ولا يُكمل برمز قديم، ودعوة بريده من جديد تعيده.
   */
  async cancelInvitation(p: Principal, orgId: string, userId: string): Promise<void> {
    this.assertVisible(p, orgId);
    if (!UUID.test(userId)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const { org, member } = await this.invited(tx, orgId, userId, 'cancelled');
      if (member.conflict) {
        const [c] = await tx
          .update(buyerInviteConflicts)
          .set({ state: 'dismissed', resolvedAt: sql`now()`, resolvedBy: p.userId, updatedAt: sql`now()` })
          .where(eq(buyerInviteConflicts.id, userId))
          .returning({ existing: buyerInviteConflicts.existingUserId });
        await audit(tx, p.userId, 'buyer_member.invitation_cancelled', c!.existing, { organization_id: orgId, target_user_id: c!.existing, conflict_id: userId });
      } else {
        await expireOpenTokens(tx, userId);
        await resetCredentials(tx, userId);
        await tx.update(users).set({ membershipSuspended: true }).where(eq(users.id, userId));
        await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), inArray(userRoles.role, [...BUYER_ROLES])));
        await audit(tx, p.userId, 'buyer_member.invitation_cancelled', userId, { organization_id: orgId, target_user_id: userId });
      }
      if (org.status === 'active') assertAdminRemains(await memberRows(tx, orgId));
    });
  }

  /** العضو المدعو تحت قفل مؤسسته: المجهول 404، ومن أكمل القبول أو عُلّق `invalid_transition`. */
  private async invited(tx: Tx, orgId: string, userId: string, to: string): Promise<{ org: OrgRow; member: MemberRow }> {
    const [org] = await tx.select().from(buyerOrganizations).where(eq(buyerOrganizations.id, orgId)).for('update');
    if (!org) throw ApiError.notFound();
    const member = (await memberRows(tx, orgId)).find((m) => m.id === userId);
    if (!member) throw ApiError.notFound();
    if (member.status !== 'invited') {
      throw new ApiError(409, 'invalid_transition', `Only an invitation that has not been accepted can change; this member is ${member.status}.`, { from: member.status, to });
    }
    return { org, member };
  }

  /** رمز جديد لمدعو قائم، ودوره إن طُلب غيره. التعارض يُمدَّد أجله وحده: لا رمز له يُسلَّم. */
  private async reissue(tx: Tx, actorId: string, orgId: string, member: MemberRow, token: string, role?: BuyerRole): Promise<Issued> {
    const changed = role !== undefined && role !== member.role;
    if (member.conflict) {
      const [c] = await tx
        .update(buyerInviteConflicts)
        .set({ ...(changed ? { role } : {}), inviteExpiresAt: sql`now() + interval '24 hours'`, updatedAt: sql`now()` })
        .where(eq(buyerInviteConflicts.id, member.id))
        .returning({ existing: buyerInviteConflicts.existingUserId, expiresAt: buyerInviteConflicts.inviteExpiresAt });
      await audit(tx, actorId, 'buyer_member.invitation_reissued', c!.existing, { organization_id: orgId, target_user_id: c!.existing, conflict_id: member.id });
      return { conflict: true, userId: member.id, expiresAt: iso(c!.expiresAt)! };
    }
    if (changed) {
      await tx
        .update(userRoles)
        .set({ role })
        .where(and(eq(userRoles.userId, member.id), inArray(userRoles.role, [...BUYER_ROLES])));
      await audit(tx, actorId, 'buyer_member.role_changed', member.id, { organization_id: orgId, target_user_id: member.id, from: member.role, to: role });
    }
    await expireOpenTokens(tx, member.id);
    // كل وصول وسرّ معلّق من محاولة لم تكتمل يُمحى: السرّ لا يُعرض ثانية، والدورة تبدأ من أولها
    await resetCredentials(tx, member.id);
    const request = await this.issueToken(tx, member.id, actorId, token);
    await audit(tx, actorId, 'buyer_member.invitation_reissued', member.id, { organization_id: orgId, target_user_id: member.id });
    return { conflict: false, userId: member.id, ...request };
  }

  /** الرد بشكل واحد للحساب الحقيقي والتعارض: التعارض لا يُسلَّم لأحد؛ رمزه عشوائي لا يُحفظ، ويظهر حيث يظهر رمز الدعوة وحده. */
  private async answer(orgId: string, token: string, issued: Issued): Promise<BuyerMember & InviteToken> {
    const invite = issued.conflict
      ? this.delivery.outOfBand
        ? {}
        : { invite_token: randomToken(32), invite_token_expires_at: issued.expiresAt }
      : await this.handOver(token, issued);
    const [row] = (await memberRows(this.db, orgId)).filter((m) => m.id === issued.userId);
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
      // العضوية مستقلة عن حالة الحساب على المنصة (ADR 0118): هذا المسار لا يرفع تعليقًا وضعه مدير النظام على الحساب
      if (current.platformSuspended && input.status === 'active') {
        throw new ApiError(403, 'forbidden_role', 'A platform suspension is lifted by a system administrator through the account status only.');
      }
      const reactivating = current.status === 'suspended' && input.status === 'active';
      if (reactivating && (await seatsTaken(tx, orgId)) >= org.seats) throw new ApiError(409, 'seats_exhausted', 'The organization has no free seat.');
      if (current.conflict) {
        // العضو المدعو المتعارض يُعدَّل كأي مدعو: الدور، والتعليق وإعادته (معلّقًا يخرج من المقاعد)
        await tx
          .update(buyerInviteConflicts)
          .set({ role: input.role, state: input.status === 'suspended' ? 'suspended' : 'pending', updatedAt: sql`now()` })
          .where(eq(buyerInviteConflicts.id, userId));
      } else {
        await tx
          .update(userRoles)
          .set({ role: input.role })
          .where(and(eq(userRoles.userId, userId), inArray(userRoles.role, [...BUYER_ROLES])));
        const suspend = input.status === 'suspended';
        if (suspend !== current.membershipSuspended) {
          await tx.update(users).set({ membershipSuspended: suspend }).where(eq(users.id, userId));
          // تعليق العضوية يبطل كل وصول العضو فورًا كالتعليق على المنصة؛ وإعادتها لا تعيد شيئًا منه
          if (suspend) await revokeAllAccess(tx, userId);
        }
      }
      if (org.status === 'active') assertAdminRemains(await memberRows(tx, orgId));
      if (input.role !== current.role) {
        await audit(tx, p.userId, 'buyer_member.role_changed', userId, { organization_id: orgId, target_user_id: userId, from: current.role, to: input.role });
      }
      // تغيّر العضوية وحدها يُدقَّق؛ حالة الحساب على المنصة لا يغيّرها هذا المسار
      if ((input.status === 'suspended') !== current.membershipSuspended) {
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
    const [active, occupied] = await Promise.all([activeCounts(executor, [id]), occupiedCounts(executor, [id])]);
    return { org: toDto(org, active.get(id) ?? 0, occupied.get(id) ?? 0), etag: await etagOf(executor, id) };
  }

  /** حساب المشتري: كلمة سر لا يعرفها أحد، ودور بنطاق مؤسسته، وطلب استعادة معتمد برمز تعيين لمرة واحدة (24 ساعة). */
  private async createMember(
    tx: Tx,
    orgId: string,
    actorId: string,
    email: string,
    role: BuyerRole,
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
      if (pgError(err).constraint === 'users_email_lower_key') throw emailTaken();
      throw err;
    }
    await tx.insert(userRoles).values({ userId, role, scopeKind: 'organization', scopeId: orgId, grantedBy: actorId });
    return { userId, ...(await this.issueToken(tx, userId, actorId, token)) };
  }

  /** طلب استعادة معتمد يحمل رمز الدعوة ببصمته (24 ساعة). */
  private async issueToken(tx: Tx, userId: string, actorId: string, token: string): Promise<{ recoveryRequestId: string; expiresAt: string }> {
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
    return { recoveryRequestId: request!.id, expiresAt: iso(request!.expiresAt)! };
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

/**
 * تغيّر حالة مؤسسة (ADR 0104): حدث buyer_organization.status_changed بالمعرّف والحالتين والسبب المرمّز وحده، وتدقيق بالمفاتيح
 * نفسها. لا اسم ولا بريد.
 */
async function recordStatusChange(tx: Tx, actorId: string, orgId: string, from: Status, to: Status, reason: RejectionReason | null): Promise<void> {
  await writeOutboxEvent(tx, {
    type: 'buyer_organization.status_changed',
    aggregateType: 'organization',
    aggregateId: orgId,
    idempotencyKey: `buyer_organization.status_changed:${orgId}:${to}:${randomUUID()}`,
    actorId,
    payload: { organization_id: orgId, from, to, reason_code: reason },
  });
  await audit(tx, actorId, 'buyer_organization.status_changed', actorId, {
    organization_id: orgId,
    from,
    to,
    ...(reason ? { reason_code: reason } : {}),
  });
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
    .where(and(inArray(users.organizationId, ids), eq(users.status, 'active'), eq(users.membershipSuspended, false), eq(users.credentialResetRequired, false)))
    .groupBy(users.organizationId);
  return new Map(rows.map((r) => [r.org!, Number(r.n)]));
}

/** المقاعد المشغولة لكل مؤسسة (كما يحسبها seatsTaken)، لعدّاد الملف. */
async function occupiedCounts(executor: Executor, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const [accounts, conflicts] = await Promise.all([
    executor
      .select({ org: users.organizationId, n: count() })
      .from(users)
      .where(and(inArray(users.organizationId, ids), ne(users.status, 'suspended'), eq(users.membershipSuspended, false)))
      .groupBy(users.organizationId),
    executor
      .select({ org: buyerInviteConflicts.organizationId, n: count() })
      .from(buyerInviteConflicts)
      .where(and(inArray(buyerInviteConflicts.organizationId, ids), eq(buyerInviteConflicts.state, 'pending')))
      .groupBy(buyerInviteConflicts.organizationId),
  ]);
  const totals = new Map<string, number>();
  for (const r of [...accounts, ...conflicts]) totals.set(r.org!, (totals.get(r.org!) ?? 0) + Number(r.n));
  return totals;
}

/** لا تبقى مؤسسة فعّالة بلا مدير غير معلّق. */
function assertAdminRemains(rows: MemberRow[]): void {
  if (!rows.some((m) => m.role === 'buyer_admin' && m.status !== 'suspended')) {
    throw new ApiError(409, 'last_buyer_admin', 'An active organization keeps at least one active buyer administrator.');
  }
}

/** رموز الدعوة التي لم تُستعمل تنتهي: لا يُكمل بها أحد بعد إعادة الإصدار أو الإلغاء. */
async function expireOpenTokens(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(recoveryRequests)
    .set({ state: 'expired', resetTokenHash: null, resetTokenExpiresAt: null })
    .where(and(eq(recoveryRequests.userId, userId), eq(recoveryRequests.state, 'approved'), isNull(recoveryRequests.completedAt)));
}

const emailTaken = () => new ApiError(409, 'bad_request', 'An account with this email exists.', { fields: ['/email'] });

/** المقاعد المشغولة: كل حساب غير معلّق في المؤسسة، وكل دعوة متعارضة لم تُعلَّق ولم تُحسم. */
async function seatsTaken(executor: Executor, orgId: string): Promise<number> {
  const [{ n }] = (await executor
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.organizationId, orgId), ne(users.status, 'suspended'), eq(users.membershipSuspended, false)))) as [{ n: number }];
  const [{ c }] = (await executor
    .select({ c: count() })
    .from(buyerInviteConflicts)
    .where(and(eq(buyerInviteConflicts.organizationId, orgId), eq(buyerInviteConflicts.state, 'pending')))) as [{ c: number }];
  return Number(n) + Number(c);
}

/** الحساب القائم بهذا البريد. `neverAccepted`: دعوة لم يكتمل قبولها (لم يدخل قط وما زال تعيين كلمته مطلوبًا) وحسابه غير معلّق على المنصة. */
async function existingAccount(executor: Executor, email: string): Promise<{ id: string; organizationId: string | null; neverAccepted: boolean } | undefined> {
  const [u] = await executor
    .select({ id: users.id, organizationId: users.organizationId, status: users.status, resetRequired: users.credentialResetRequired, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);
  return u ? { id: u.id, organizationId: u.organizationId, neverAccepted: u.status === 'active' && u.resetRequired && u.lastLoginAt === null } : undefined;
}

interface MemberRow {
  id: string;
  conflict: boolean;
  /** تعليق الحساب على المنصة (مدير النظام) */
  platformSuspended: boolean;
  /** تعليق العضوية في المؤسسة (مدير المؤسسة) */
  membershipSuspended: boolean;
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
      membershipSuspended: users.membershipSuspended,
      lastLoginAt: users.lastLoginAt,
      resetRequired: users.credentialResetRequired,
      totpEnabled: users.totpEnabled,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(userRoles, and(eq(userRoles.userId, users.id), inArray(userRoles.role, [...BUYER_ROLES])))
    .where(eq(users.organizationId, orgId));
  const conflicts = await executor
    .select()
    .from(buyerInviteConflicts)
    .where(and(eq(buyerInviteConflicts.organizationId, orgId), ne(buyerInviteConflicts.state, 'dismissed')));
  const members: MemberRow[] = rows.map((r) => ({
    id: r.id,
    conflict: false,
    platformSuspended: r.userStatus === 'suspended',
    membershipSuspended: r.membershipSuspended,
    email: r.email,
    role: r.role,
    // المدعو لم يعيّن كلمته بعد؛ المعلّق بحالة حسابه على المنصة أو بعضويته
    status: r.userStatus === 'suspended' || r.membershipSuspended ? 'suspended' : r.resetRequired && r.lastLoginAt === null ? 'invited' : 'active',
    totpEnabled: r.totpEnabled,
    createdAt: r.createdAt,
  }));
  // الدعوة المتعارضة عضو مدعو لا يكتمل أبدًا (حتى يحسمها مدير النظام)
  for (const c of conflicts) {
    members.push({ id: c.id, conflict: true, platformSuspended: false, membershipSuspended: c.state === 'suspended', email: c.email, role: c.role, status: c.state === 'suspended' ? 'suspended' : 'invited', totpEnabled: false, createdAt: c.createdAt });
  }
  // الطابعان بصيغة القاعدة نفسها، فالترتيب النصي ترتيب زمني
  return members.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
}

function toMember(r: MemberRow): BuyerMember {
  return { user_id: r.id, email: r.email, role: r.role as BuyerMember['role'], status: r.status, totp_enabled: r.totpEnabled, created_at: iso(r.createdAt)! };
}

function toDto(o: OrgRow, activeMembers: number, occupiedSeats: number): BuyerOrganization {
  return {
    id: o.id,
    legal_name: o.legalName,
    display_name: { ar: o.displayNameAr, en: o.displayNameEn },
    country: o.country,
    billing_email: o.billingEmail,
    seats: o.seats,
    status: o.status as Status,
    active_members: activeMembers,
    // من يشغل مقعدًا ولم يصر نشطًا بعد: النشطون والمدعوون معًا هم المقاعد المشغولة
    invited_members: Math.max(0, occupiedSeats - activeMembers),
    verified_at: iso(o.verifiedAt),
    // يظهر مع rejected وحدها (ADR 0104)، فيبقى الملف المقروء صالحًا جسمًا لـ PUT في غيرها
    ...(o.rejectionReason ? { rejection_reason: o.rejectionReason as RejectionReason } : {}),
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
