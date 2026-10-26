import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import {
  buyerOrganizations,
  catalogListings,
  exclusiveHolds,
  licenses,
  licenseTemplateVersions,
  listingOffers,
  materialContributors,
  materials,
  orderItems,
  orders,
  paymentEvents,
} from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { validTimestamp } from '../uploads/uploads.service';
import { applicableRule, type AppliedRule } from './commission-rules';
import { requestDelivery } from './delivery';
import { postEntry, type AccountRef } from './ledger';
import { allocate, type Currency, money, type Money, percentToBasisPoints } from './money';
import { PAYMENT_PROVIDER, type PaymentProvider, type ProviderEvent, WebhookSignatureError } from './payment-provider';
import { IgnoredWebhookEvent, LiveModeEvent } from './stripe-provider';
import { applyRefundSucceeded } from './refunds';

export type Order = components['schemas']['Order'];
export type OrderCreate = components['schemas']['OrderCreate'];
type OrderRow = typeof orders.$inferSelect;
type ItemRow = typeof orderItems.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUYER_ROLES = ['buyer_admin', 'buyer_member'] as const;
const HOLD_MINUTES = 15;
const ORDER_HOURS = 24;
// أبجدية Crockford بلا I وL وO وU، كما في نمط رقم الترخيص في العقد
const LICENSE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * الطلبات والدفع التجريبي (العقد v0.3، الجزء 4، ADR 0025 وADR 0032). الطلب يُنشأ مرة من السلة ويجمّد لكل بند الإدراج
 * وإصدار المادة والإصدار الحالي لقالب الترخيص والسعر، والقاعدة تعيد التحقق بمحفّز. البند الحصري يحجز المادة 15 دقيقة.
 * الدفع في صفحة مستضافة لدى المزوّد، والتأكيد من الإشعار الموقّع وحده: في معاملة واحدة يُسجَّل الإشعار، ويُدفع الطلب،
 * وتصدر التراخيص، ويُكتب قيد البيعة في الدفتر، وأحداث Outbox، وطلب حزمة التسليم. التكرار بلا أثر. لا مال حقيقي.
 */
@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  async create(p: Principal, input: OrderCreate): Promise<Order> {
    const orgId = p.organizationId;
    if (!orgId) throw new ApiError(403, 'forbidden_scope', 'Only buyers place orders.');
    const listingIds = input.items.map((i) => i.listing_id);
    if (new Set(listingIds).size !== listingIds.length) throw ApiError.validation({ fields: ['/items'] });
    return this.db.transaction(async (tx) => {
      const [org] = await tx.select({ status: buyerOrganizations.status }).from(buyerOrganizations).where(eq(buyerOrganizations.id, orgId)).for('share');
      if (org?.status !== 'active') throw new ApiError(403, 'forbidden_scope', 'The organization cannot buy until it is active.');
      const items = [];
      for (const it of input.items) items.push(await frozenItem(tx, it.listing_id, it.license_template_id));
      const currency = items[0]!.currency;
      if (items.some((i) => i.currency !== currency)) throw new ApiError(422, 'mixed_currency', 'An order is in one currency.', { fields: ['/items'] });
      const total = items.reduce((a, i) => a + BigInt(i.priceMinor), 0n);
      if (input.expected_total && (BigInt(input.expected_total.amount_minor) !== total || input.expected_total.currency !== currency)) {
        throw new ApiError(409, 'price_changed', 'The total changed since it was shown.');
      }
      const exclusive = items.some((i) => i.licenseType === 'exclusive_temporary');
      try {
        const [order] = await tx
          .insert(orders)
          .values({
            organizationId: orgId,
            createdBy: p.userId,
            currency,
            totalMinor: sql`${total.toString()}::bigint` as unknown as number,
            expiresAt: exclusive ? sql`now() + make_interval(mins => ${HOLD_MINUTES})` : sql`now() + make_interval(hours => ${ORDER_HOURS})`,
          })
          .returning();
        for (const i of items) {
          const [row] = await tx.insert(orderItems).values({ ...i, orderId: order!.id }).returning();
          if (i.licenseType === 'exclusive_temporary') {
            await releaseExpiredHolds(tx, i.materialId);
            await tx.insert(exclusiveHolds).values({ materialId: i.materialId, orderItemId: row!.id, heldUntil: sql`now() + make_interval(mins => ${HOLD_MINUTES})` });
          }
        }
        await statusEvent(tx, order!);
        return read(tx, order!.id);
      } catch (err) {
        throw mapGuard(err);
      }
    });
  }

  async list(p: Principal, q: { status?: string; organization_id?: string; cursor?: string; limit?: number }): Promise<{ items: Order[]; next_cursor: string | null }> {
    const limit = q.limit ?? 50;
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db
      .select({ id: orders.id, at: sql<string>`${orders.createdAt}::text` })
      .from(orders)
      .where(
        and(
          scope(p),
          !isBuyer(p) && q.organization_id ? eq(orders.organizationId, q.organization_id) : undefined,
          q.status ? eq(orders.status, q.status) : undefined,
          after ? sql`(${orders.createdAt}, ${orders.id}) < (${after.at}::timestamptz, ${after.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((r) => read(this.db, r.id))),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.at, last.id])).toString('base64url') : null,
    };
  }

  async get(p: Principal, id: string): Promise<Order> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [o] = await this.db.select({ id: orders.id }).from(orders).where(and(eq(orders.id, id), scope(p)));
    if (!o) throw ApiError.notFound();
    return read(this.db, id);
  }

  /** جلسة الدفع: يُعاد التحقق من المهلة والحجز الحصري قبل إنشائها، والتكرار والجلسة صالحة يعيد الجلسة نفسها. */
  async checkout(p: Principal, id: string): Promise<components['schemas']['CheckoutSession']> {
    if (!this.provider) throw new ApiError(409, 'order_state_conflict', 'No payment provider is configured.');
    const provider = this.provider;
    if (!UUID.test(id)) throw ApiError.notFound();
    // المهلة تُطبَّق في معاملتها، فلا يلغيها رفض ما يليها
    await this.db.transaction((tx) => stillOpen(tx, id));
    // التحقق تحت القفل، ثم نداء المزوّد خارج أي معاملة (لا قفل على الطلب أثناء انتظار الشبكة)، ثم الحفظ بتحقق ثانٍ.
    // المفتاح checkout:<id> يجعل الإعادة بعد فشل الحفظ الجلسةَ نفسها عند المزوّد
    const o = await this.db.transaction((tx) => this.payable(tx, p, id));
    const session = await provider.createCheckout({
      orderId: id,
      amount: money(o.totalMinor, o.currency as Currency),
      // صفحة الويب من الإعداد وحده بمعرّف الطلب؛ بلا قالب لا عودة
      returnUrl: this.config.SANDBOX_RETURN_URL ? this.config.SANDBOX_RETURN_URL.replace('{order_id}', id) : '',
      idempotencyKey: `checkout:${id}`,
    });
    return this.db.transaction(async (tx) => {
      const now = await this.payable(tx, p, id);
      await tx.update(orders).set({ provider: provider.name, providerRef: session.providerRef }).where(eq(orders.id, id));
      const expires = new Date(Math.min(session.expiresAt.getTime(), new Date(now.expiresAt).getTime()));
      return { checkout_url: session.checkoutUrl, provider: provider.name, expires_at: expires.toISOString() };
    });
  }

  /** الطلب مقفلًا ينتظر الدفع، وحجزه الحصري ما زال قائمًا؛ وإلا 404 أو 409. */
  private async payable(tx: Tx, p: Principal, id: string): Promise<typeof orders.$inferSelect> {
    const [o] = await tx.select().from(orders).where(and(eq(orders.id, id), scope(p))).for('update');
    if (!o) throw ApiError.notFound();
    if (o.status !== 'pending_payment') {
      throw new ApiError(409, 'order_state_conflict', 'The order is not awaiting payment.');
    }
    const lost = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .leftJoin(exclusiveHolds, eq(exclusiveHolds.orderItemId, orderItems.id))
      .where(and(eq(orderItems.orderId, id), eq(orderItems.licenseType, 'exclusive_temporary'), sql`(${exclusiveHolds.state} IS DISTINCT FROM 'held' OR ${exclusiveHolds.heldUntil} <= now())`));
    if (lost.length > 0) throw new ApiError(409, 'exclusive_unavailable', 'The exclusive hold is no longer held.');
    return o;
  }

  async cancel(p: Principal, id: string): Promise<Order> {
    if (!UUID.test(id)) throw ApiError.notFound();
    await this.db.transaction((tx) => stillOpen(tx, id));
    return this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(orders).where(and(eq(orders.id, id), scope(p))).for('update');
      if (!o) throw ApiError.notFound();
      if (o.status !== 'pending_payment') {
        throw new ApiError(409, 'order_state_conflict', 'Only an unpaid order can be cancelled.');
      }
      const [after] = await tx.update(orders).set({ status: 'cancelled', cancelReason: 'buyer' }).where(eq(orders.id, id)).returning();
      await releaseHolds(tx, id);
      await statusEvent(tx, after!);
      return read(tx, id);
    });
  }

  /**
   * الإشعار الموقّع (ADR 0032): التوقيع قبل التحليل، ثم `(provider, event_id)` مرة واحدة تحت قفل استشاري، والنتيجة في
   * معاملة واحدة. المكرر والمجهول والمحسوم 200 بلا أثر؛ والمبلغ غير المطابق يُكتب للمراجعة بلا ترخيص.
   */
  async webhook(providerName: string, rawBody: Buffer, headers: Record<string, string | undefined>): Promise<{ received: true }> {
    if (!this.provider || providerName !== this.provider.name) throw ApiError.notFound();
    let event: ProviderEvent;
    try {
      event = this.provider.verifyWebhook(rawBody, headers);
    } catch (err) {
      if (err instanceof WebhookSignatureError) throw new ApiError(400, 'webhook_signature_invalid', 'The webhook signature is invalid.');
      // حدث موقّع صحيح لا يخص الدفع عندنا (أنواع Stripe الأخرى): يُقبل بلا أثر ولا يُخزَّن
      if (err instanceof IgnoredWebhookEvent) return { received: true };
      if (err instanceof LiveModeEvent) throw new ApiError(400, 'live_payments_disabled', 'Live payments are disabled.');
      throw err;
    }
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payment:${providerName}:${event.eventId}`}))`);
      const [seen] = await tx
        .select({ id: paymentEvents.eventId })
        .from(paymentEvents)
        .where(and(eq(paymentEvents.provider, providerName), eq(paymentEvents.eventId, event.eventId)));
      if (seen) return;
      let orderId: string | null;
      let outcome: 'applied' | 'ignored' | 'review';
      if (event.type === 'refund.succeeded') {
        // بمرجع الاسترداد، أو بمرجع الدفع حين يحمله إشعار المزوّد
        ({ orderId, outcome } = await applyRefundSucceeded(tx, providerName, event));
      } else {
        const [o] = await tx.select().from(orders).where(and(eq(orders.provider, providerName), eq(orders.providerRef, event.providerRef))).for('update');
        orderId = o?.id ?? null;
        outcome = o ? await this.apply(tx, o, event) : 'ignored';
      }
      await tx.insert(paymentEvents).values({
        provider: providerName,
        eventId: event.eventId,
        type: event.type,
        providerRef: event.providerRef,
        amountMinor: sql`${event.amount.amountMinor.toString()}::bigint` as unknown as number,
        currency: event.amount.currency,
        occurredAt: event.occurredAt.toISOString(),
        orderId,
        outcome,
      });
    });
    return { received: true };
  }

  private async apply(tx: Tx, o: OrderRow, event: ProviderEvent): Promise<'applied' | 'ignored' | 'review'> {
    if (event.type === 'dispute.opened') return 'review';
    if (event.type === 'payment.failed') return o.status === 'pending_payment' ? 'applied' : 'ignored';
    if (o.status !== 'pending_payment' && o.status !== 'expired') return 'ignored';
    if (event.amount.currency !== o.currency || event.amount.amountMinor !== BigInt(o.totalMinor)) return 'review';
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(orderItems.id);
    // إعادة التحقق عند التأكيد: الحجز الحصري قائم لم يُحرَّر، والحقوق قابلة للبيع
    const reason = await revalidate(tx, items);
    if (reason) {
      // الدفع بلا ترخيص يُسترد (الجزء 5)؛ الطلب المعلّق يُلغى بسببه، والمنتهي يبقى منتهيًا
      if (o.status === 'pending_payment') {
        const [after] = await tx.update(orders).set({ status: 'cancelled', cancelReason: reason }).where(eq(orders.id, o.id)).returning();
        await releaseHolds(tx, o.id);
        await statusEvent(tx, after!);
      }
      return 'review';
    }
    const [paid] = await tx.update(orders).set({ status: 'paid', paidAt: sql`now()` }).where(eq(orders.id, o.id)).returning();
    await statusEvent(tx, paid!);
    for (const item of items) await this.issue(tx, paid!, item);
    await this.postSale(tx, paid!, items);
    return 'applied';
  }

  private async issue(tx: Tx, o: OrderRow, item: ItemRow): Promise<void> {
    const [v] = await tx
      .select()
      .from(licenseTemplateVersions)
      .where(and(eq(licenseTemplateVersions.templateId, item.licenseTemplateId), eq(licenseTemplateVersions.version, item.licenseVersion)));
    const exclusive = item.licenseType === 'exclusive_temporary';
    const [license] = await tx
      .insert(licenses)
      .values({
        licenseNumber: licenseNumber(),
        orderItemId: item.id,
        organizationId: o.organizationId,
        materialId: item.materialId,
        licenseType: item.licenseType,
        validFrom: sql`now()`,
        validUntil: v!.termDays ? sql`now() + make_interval(days => ${v!.termDays})` : null,
        exclusiveUntil: exclusive ? sql`now() + make_interval(hours => ${v!.exclusivityHours})` : null,
      })
      .returning();
    if (exclusive) {
      await tx
        .update(exclusiveHolds)
        .set({ state: 'active', activeUntil: sql`now() + make_interval(hours => ${v!.exclusivityHours})` })
        .where(eq(exclusiveHolds.orderItemId, item.id));
    }
    await writeOutboxEvent(tx, {
      type: 'license.issued',
      aggregateType: 'license',
      aggregateId: license!.id,
      idempotencyKey: `license.issued:${license!.id}`,
      payload: {
        license_id: license!.id,
        order_id: o.id,
        organization_id: o.organizationId,
        material_id: item.materialId,
        material_version: item.materialVersion,
        license_type: item.licenseType,
      },
    });
    // النسخة المنتَجة لا تُسلَّم قبل نوعها في العقد (#278)؛ والمادة بلا أصل متحقق لا تمنع الدفع، فتُبنى حزمتها لاحقًا
    const deliverables = v!.deliverables.filter((d) => d !== 'produced');
    if (deliverables.length === 0) return;
    try {
      await requestDelivery(tx, { licenseId: license!.id, materialId: item.materialId, deliverables, producedFileId: null, actorId: null });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }

  /**
   * قيد البيعة (ADR 0031): مدين المزوّد بالإجمالي، ودائن إيراد المنصة بعمولتها ومستحق كل مساهم (معلّقًا) بحصته من
   * صافي كل بند. المزوّد التجريبي بلا رسوم ولا ضريبة. العمولة السارية تُجمَّد في تفاصيل القيد.
   */
  private async postSale(tx: Tx, o: OrderRow, items: ItemRow[]): Promise<void> {
    const currency = o.currency as Currency;
    if (BigInt(o.totalMinor) === 0n) return;
    const lines = new Map<string, { account: AccountRef; amount: bigint }>();
    const credit = (key: string, account: AccountRef, amount: bigint) => {
      const cur = lines.get(key);
      lines.set(key, { account, amount: (cur?.amount ?? 0n) - amount });
    };
    const applied: AppliedRule[] = [];
    for (const item of items) {
      // قاعدة العمولة السارية لحظة تأكيد الدفع (الجزء 6)، وبلا قاعدة PLATFORM_COMMISSION_BASIS_POINTS
      const rule = await applicableRule(tx, item, o.paidAt!, this.config.PLATFORM_COMMISSION_BASIS_POINTS);
      applied.push(rule);
      const bp = BigInt(rule.basisPoints);
      const price = money(item.priceMinor, currency);
      const split = allocate(price, [
        { key: 'platform', weight: bp },
        { key: 'contributors', weight: 10_000n - bp },
      ]);
      credit('platform', { kind: 'platform_revenue', currency }, split.get('platform')!.amountMinor);
      const shares = await contributorShares(tx, item.materialId);
      for (const [owner, m] of allocate(split.get('contributors')!, shares)) {
        credit(`c:${owner}`, { kind: 'contributor_payable', ownerId: owner, state: 'pending', currency }, m.amountMinor);
      }
    }
    const postings: Array<{ account: AccountRef; amount: Money }> = [{ account: { kind: 'provider_clearing', currency }, amount: money(BigInt(o.totalMinor), currency) }];
    for (const l of lines.values()) if (l.amount !== 0n) postings.push({ account: l.account, amount: money(l.amount, currency) });
    await postEntry(tx, {
      kind: 'sale',
      referenceType: 'order',
      referenceId: o.id,
      // القاعدة المجمّدة لكل بند بترتيب البنود
      // نقاط المنصة رقمًا واحدًا حين تتفق البنود (وإلا null)، والقاعدة ونقاطها لكل بند بترتيب البنود
      details: {
        platform_basis_points: applied.every((r) => r.basisPoints === applied[0]!.basisPoints) ? applied[0]!.basisPoints : null,
        commission_rules: applied.map((r) => r.ruleId),
        item_basis_points: applied.map((r) => r.basisPoints),
      },
      idempotencyKey: `sale:${o.id}`,
      actorId: null,
      postings,
    });
  }
}

function isBuyer(p: Principal): boolean {
  return p.roles.some((r) => (BUYER_ROLES as readonly string[]).includes(r.role));
}

/** مدير المؤسسة يرى طلباتها، والعضو ما أنشأه منها وحده، والطاقم الكل. */
function scope(p: Principal) {
  if (!isBuyer(p)) return undefined;
  if (hasRole(p, 'buyer_admin')) return eq(orders.organizationId, p.organizationId ?? '00000000-0000-0000-0000-000000000000');
  return and(eq(orders.organizationId, p.organizationId ?? '00000000-0000-0000-0000-000000000000'), eq(orders.createdBy, p.userId));
}

async function frozenItem(tx: Tx, listingId: string, templateId: string) {
  if (!UUID.test(listingId) || !UUID.test(templateId)) throw new ApiError(409, 'listing_unavailable', 'The offer is not available.');
  const [l] = await tx.select().from(catalogListings).where(eq(catalogListings.id, listingId));
  const [offer] = await tx
    .select()
    .from(listingOffers)
    .where(and(eq(listingOffers.listingId, listingId), eq(listingOffers.licenseTemplateId, templateId)));
  const [v] = await tx
    .select()
    .from(licenseTemplateVersions)
    .where(eq(licenseTemplateVersions.templateId, templateId))
    .orderBy(desc(licenseTemplateVersions.version))
    .limit(1);
  if (!l || l.state !== 'listed' || !offer || !v || !v.enabled) throw new ApiError(409, 'listing_unavailable', 'The offer is not available.');
  return {
    listingId,
    materialId: l.materialId,
    materialVersion: l.materialVersion,
    licenseTemplateId: templateId,
    licenseVersion: v.version,
    licenseType: v.type,
    priceMinor: offer.priceOverrideMinor ?? v.basePriceMinor,
    currency: offer.priceOverrideCurrency ?? v.currency,
    titleAr: l.titleAr,
    titleEn: l.titleEn,
  };
}

/** رفض المحفّزات إلى رموز العقد: الحجز المتزامن (23505) أو البيع تحت حجز ساري حصريةٌ غير متاحة، وغيره عرض غير متاح. */
function mapGuard(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  const { code, constraint } = pgError(err);
  if (code === '23505' && constraint === 'exclusive_holds_material_key') return new ApiError(409, 'exclusive_unavailable', 'The material is held or sold exclusively.');
  if (code === '23514') {
    const message = String((err as { cause?: { message?: string }; message?: string }).cause?.message ?? (err as { message?: string }).message ?? '');
    if (/exclusive|already licensed/.test(message)) return new ApiError(409, 'exclusive_unavailable', 'The material is held or sold exclusively.');
    return new ApiError(409, 'listing_unavailable', 'The offer is not available.');
  }
  return err;
}

/** الحجوزات المنتهية للمادة تُحرَّر قبل حجز جديد، وطلباتها المعلّقة تنتهي. */
async function releaseExpiredHolds(tx: Tx, materialId: string): Promise<void> {
  const stale = await tx
    .update(exclusiveHolds)
    .set({ state: 'released', releasedAt: sql`now()` })
    .where(and(eq(exclusiveHolds.materialId, materialId), eq(exclusiveHolds.state, 'held'), lte(exclusiveHolds.heldUntil, sql`now()`)))
    .returning({ orderItemId: exclusiveHolds.orderItemId });
  if (stale.length === 0) return;
  const owners = await tx.select({ orderId: orderItems.orderId }).from(orderItems).where(inArray(orderItems.id, stale.map((s) => s.orderItemId)));
  for (const { orderId } of owners) await stillOpen(tx, orderId);
}

/** المهلة: الطلب المعلّق الذي فاتت مهلته ينتهي هنا (كسولًا، عند لمسه) ويحرر حجزه. */
async function stillOpen(tx: Tx, orderId: string): Promise<boolean> {
  const expired = await tx
    .update(orders)
    .set({ status: 'expired' })
    .where(and(eq(orders.id, orderId), eq(orders.status, 'pending_payment'), lte(orders.expiresAt, sql`now()`)))
    .returning();
  if (expired.length === 0) return true;
  await releaseHolds(tx, orderId);
  await statusEvent(tx, expired[0]!);
  return false;
}

async function releaseHolds(tx: Tx, orderId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE exclusive_holds h SET state = 'released', released_at = now()
      FROM order_items i WHERE i.id = h.order_item_id AND i.order_id = ${orderId} AND h.state = 'held'`);
}

async function revalidate(tx: Tx, items: ItemRow[]): Promise<'exclusivity_lost' | 'rights_changed' | null> {
  for (const item of items) {
    const [m] = await tx.select({ rights: materials.rightsState }).from(materials).where(eq(materials.id, item.materialId)).for('no key update');
    if (m?.rights !== 'sellable') return 'rights_changed';
    if (item.licenseType === 'exclusive_temporary') {
      const [h] = await tx.select({ state: exclusiveHolds.state }).from(exclusiveHolds).where(eq(exclusiveHolds.orderItemId, item.id));
      if (h?.state !== 'held') return 'exclusivity_lost';
    } else {
      const [busy] = await tx
        .select({ id: exclusiveHolds.id })
        .from(exclusiveHolds)
        .where(
          and(
            eq(exclusiveHolds.materialId, item.materialId),
            sql`((${exclusiveHolds.state} = 'held' AND ${exclusiveHolds.heldUntil} > now()) OR (${exclusiveHolds.state} = 'active' AND ${exclusiveHolds.activeUntil} > now()))`,
          ),
        );
      if (busy) return 'exclusivity_lost';
    }
  }
  return null;
}

/** حصص المساهمين من material_contributors (مجموعها 100.00)، وإلا المراسل وحده. */
async function contributorShares(tx: Tx, materialId: string): Promise<Array<{ key: string; weight: bigint }>> {
  const rows = await tx.select({ userId: materialContributors.userId, share: materialContributors.sharePercent }).from(materialContributors).where(eq(materialContributors.materialId, materialId));
  if (rows.length > 0) return rows.map((r) => ({ key: r.userId, weight: percentToBasisPoints(String(r.share)) }));
  const [m] = await tx.select({ reporterId: materials.reporterId }).from(materials).where(eq(materials.id, materialId));
  return [{ key: m!.reporterId, weight: 1n }];
}

function licenseNumber(): string {
  const bytes = randomBytes(10);
  let tail = '';
  for (const b of bytes) tail += LICENSE_ALPHABET[b % 32];
  return `PH-${new Date().getUTCFullYear()}-${tail}`;
}

async function statusEvent(tx: Tx, o: OrderRow): Promise<void> {
  await writeOutboxEvent(tx, {
    type: 'order.status_changed',
    aggregateType: 'order',
    aggregateId: o.id,
    idempotencyKey: `order.status_changed:${o.id}:${o.status}`,
    payload: { order_id: o.id, organization_id: o.organizationId, status: o.status, cancel_reason: o.cancelReason },
  });
}

async function read(executor: Executor, id: string): Promise<Order> {
  const [o] = await executor.select().from(orders).where(eq(orders.id, id));
  const items = await executor
    .select({ item: orderItems, nameAr: licenseTemplateVersions.nameAr, nameEn: licenseTemplateVersions.nameEn, licenseId: licenses.id })
    .from(orderItems)
    .innerJoin(licenseTemplateVersions, and(eq(licenseTemplateVersions.templateId, orderItems.licenseTemplateId), eq(licenseTemplateVersions.version, orderItems.licenseVersion)))
    .leftJoin(licenses, eq(licenses.orderItemId, orderItems.id))
    .where(eq(orderItems.orderId, id))
    .orderBy(orderItems.id);
  return {
    id: o!.id,
    organization_id: o!.organizationId,
    created_by: o!.createdBy,
    status: o!.status as Order['status'],
    cancel_reason: o!.cancelReason as Order['cancel_reason'],
    total: { amount_minor: o!.totalMinor, currency: o!.currency as Currency },
    items: items.map((r) => ({
      id: r.item.id,
      listing_id: r.item.listingId,
      material_version: r.item.materialVersion,
      license_template_id: r.item.licenseTemplateId,
      license_version: r.item.licenseVersion,
      license_type: r.item.licenseType as Order['items'][number]['license_type'],
      license_name: { ar: r.nameAr, en: r.nameEn },
      title: { ar: r.item.titleAr, en: r.item.titleEn },
      price: { amount_minor: r.item.priceMinor, currency: r.item.currency as Currency },
      license_id: r.licenseId,
    })),
    expires_at: iso(o!.expiresAt)!,
    paid_at: iso(o!.paidAt),
    created_at: iso(o!.createdAt)!,
    updated_at: iso(o!.updatedAt)!,
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
