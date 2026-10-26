import { Body, Controller, Get, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { validateBody } from '../common/contract';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { auditLog, exclusiveHolds, journalEntries, ledgerAccounts, licenses, orderItems, orders, postings, refundItems, refunds } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal, Roles } from '../identity/principal';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { type AccountRef, accountId, payable, type PayableState, postEntry } from './ledger';
import { allocate, type Currency, money } from './money';
import { PAYMENT_PROVIDER, type PaymentProvider, type ProviderEvent } from './payment-provider';

type Refund = components['schemas']['Refund'];
type RefundCreate = components['schemas']['RefundCreate'];
type RefundRow = typeof refunds.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * الاسترداد ببنوده (ADR 0025 الجزء 5، العقد #333). الطلب يُنشئه المالية أو مدير النظام لطلب مدفوع: المبلغ مجموع أسعار
 * البنود المجمّدة، وتُبطَل تراخيصها ويُحرَّر حجزها الحصري في المعاملة نفسها، ثم يُطلب من المزوّد بمفتاح منع التكرار
 * `refund:<id>`. فشل الطلب لدى المزوّد يجعله `failed` فتتحرر بنوده لاسترداد جديد (والتراخيص تبقى مُبطَلة). النجاح من
 * إشعار `refund.succeeded` الموقّع وحده (applyRefundSucceeded).
 */
@Injectable()
export class RefundsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider | null,
  ) {}

  async list(p: Principal, orderId: string): Promise<{ items: Refund[] }> {
    await this.visibleOrder(this.db, p, orderId);
    const rows = await this.db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(desc(refunds.createdAt), desc(refunds.id));
    return { items: await toDtos(this.db, rows) };
  }

  async create(p: Principal, orderId: string, input: RefundCreate): Promise<Refund> {
    const created = await this.db.transaction(async (tx) => {
      const o = await this.visibleOrder(tx, p, orderId, true);
      if (o.status !== 'paid') throw new ApiError(409, 'order_state_conflict', 'Only a paid order is refunded.');
      const items = await tx
        .select()
        .from(orderItems)
        .where(and(eq(orderItems.orderId, orderId), inArray(orderItems.id, input.order_item_ids)));
      if (items.length !== input.order_item_ids.length) throw ApiError.validation({ fields: ['/order_item_ids'] });
      const amount = items.reduce((s, i) => s + BigInt(i.priceMinor), 0n);
      let refund: RefundRow;
      try {
        // نقطة حفظ: بند مسترد سابقًا (لم يفشل استرداده) يرفضه محفّز القاعدة تحت قفل صف البند
        refund = await tx.transaction(async (sp) => {
          const [r] = await sp
            .insert(refunds)
            .values({ orderId, amountMinor: sql`${amount.toString()}::bigint` as unknown as number, currency: o.currency, reasonCode: input.reason_code, createdBy: p.userId })
            .returning();
          for (const id of [...input.order_item_ids].sort()) await sp.insert(refundItems).values({ refundId: r!.id, orderItemId: id });
          return r!;
        });
      } catch (err) {
        if (pgError(err).code === '23505') throw new ApiError(409, 'already_refunded', 'An item of this refund is already refunded.');
        throw err;
      }
      const revoked = await tx
        .update(licenses)
        .set({ status: 'revoked', revokedReason: 'refunded', updatedAt: sql`now()` })
        .where(and(inArray(licenses.orderItemId, input.order_item_ids), eq(licenses.status, 'active')))
        .returning();
      for (const l of revoked) {
        await writeOutboxEvent(tx, {
          type: 'license.revoked',
          aggregateType: 'license',
          aggregateId: l.id,
          idempotencyKey: `license.revoked:${l.id}`,
          actorId: p.userId,
          payload: { license_id: l.id, organization_id: l.organizationId, material_id: l.materialId, revoked_reason: 'refunded' },
        });
      }
      // الحصرية المستردة لا تبقى حاجزة للمادة
      await tx
        .update(exclusiveHolds)
        .set({ state: 'released', releasedAt: sql`now()` })
        .where(and(inArray(exclusiveHolds.orderItemId, input.order_item_ids), inArray(exclusiveHolds.state, ['held', 'active'])));
      await tx.insert(auditLog).values({
        actorId: p.userId,
        action: 'refund.created',
        targetType: 'refund',
        targetId: refund.id,
        details: { organization_id: o.organizationId, reason_code: input.reason_code },
        hash: Buffer.alloc(32),
      });
      return { refund, providerRef: o.providerRef };
    });

    let final = created.refund;
    try {
      if (!this.provider || !created.providerRef) throw new Error('no payment provider for this order');
      const { refundRef } = await this.provider.refund({
        providerRef: created.providerRef,
        amount: money(BigInt(final.amountMinor), final.currency as Currency),
        idempotencyKey: `refund:${final.id}`,
      });
      [final] = (await this.db.update(refunds).set({ providerRefundRef: refundRef }).where(eq(refunds.id, final.id)).returning()) as [RefundRow];
    } catch {
      // المزوّد رفض الطلب أو تعذّر: البنود تتحرر لاسترداد جديد، ولا قيد
      [final] = (await this.db
        .update(refunds)
        .set({ status: 'failed', completedAt: sql`now()` })
        .where(and(eq(refunds.id, final.id), eq(refunds.status, 'pending')))
        .returning()) as [RefundRow];
    }
    return (await toDtos(this.db, [final]))[0]!;
  }

  /** المالية ومدير النظام لكل طلب، و`buyer_admin` لطلبات مؤسسته وحدها؛ غيرها 404 بشكل المفقود. */
  private async visibleOrder(executor: Executor, p: Principal, orderId: string, lock = false) {
    if (!UUID.test(orderId)) throw ApiError.notFound();
    const q = executor.select().from(orders).where(eq(orders.id, orderId));
    const [o] = lock ? await q.for('update') : await q;
    if (!o) throw ApiError.notFound();
    if (!hasRole(p, 'system_admin') && !hasRole(p, 'finance') && o.organizationId !== p.organizationId) throw ApiError.notFound();
    return o;
  }
}

/**
 * إشعار `refund.succeeded` (في معاملة الإشعار وتحت قفله): يُكتب قيد `refund` يعكس حصص البيعة بنسبة المبلغ المسترد
 * (ADR 0031)، ويصير الاسترداد `succeeded`. وحين تُسترد كل البنود يصير الطلب `refunded`. المبلغ المخالف للمراجعة.
 */
export async function applyRefundSucceeded(
  tx: Tx,
  provider: string,
  event: ProviderEvent,
): Promise<{ orderId: string | null; outcome: 'applied' | 'ignored' | 'review' }> {
  // الإشعار يحمل مرجع الاسترداد، أو مرجع الدفع (كما يفعل مزوّدون كثر): حينها أقدم استرداد معلّق للطلب بالمبلغ نفسه
  let [r] = await tx.select().from(refunds).where(eq(refunds.providerRefundRef, event.providerRef)).for('update');
  if (!r) {
    const [o] = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.provider, provider), eq(orders.providerRef, event.providerRef)));
    if (!o) return { orderId: null, outcome: 'ignored' };
    [r] = await tx
      .select()
      .from(refunds)
      .where(and(eq(refunds.orderId, o.id), eq(refunds.status, 'pending'), sql`${refunds.amountMinor} = ${event.amount.amountMinor.toString()}::bigint`))
      .orderBy(refunds.createdAt, refunds.id)
      .limit(1)
      .for('update');
    if (!r) return { orderId: o.id, outcome: 'review' };
  }
  if (r.status !== 'pending') return { orderId: r.orderId, outcome: 'ignored' };
  if (event.amount.currency !== r.currency || event.amount.amountMinor !== BigInt(r.amountMinor)) return { orderId: r.orderId, outcome: 'review' };
  const [sale] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.kind, 'sale'), eq(journalEntries.referenceType, 'order'), eq(journalEntries.referenceId, r.orderId)));
  if (!sale) return { orderId: r.orderId, outcome: 'review' };
  const entryId = await postRefund(tx, r, sale.id);
  await tx.update(refunds).set({ status: 'succeeded', entryId, completedAt: sql`now()` }).where(eq(refunds.id, r.id));

  const [{ left }] = (await tx.execute(sql`
    SELECT count(*)::int AS left FROM order_items i
     WHERE i.order_id = ${r.orderId}
       AND NOT EXISTS (SELECT 1 FROM refund_items ri JOIN refunds f ON f.id = ri.refund_id
                        WHERE ri.order_item_id = i.id AND f.status = 'succeeded')`)).rows as [{ left: number }];
  if (left === 0) {
    const [o] = await tx.update(orders).set({ status: 'refunded' }).where(eq(orders.id, r.orderId)).returning();
    await writeOutboxEvent(tx, {
      type: 'order.status_changed',
      aggregateType: 'order',
      aggregateId: o!.id,
      idempotencyKey: `order.status_changed:${o!.id}:${o!.status}`,
      payload: { order_id: o!.id, organization_id: o!.organizationId, status: o!.status, cancel_reason: o!.cancelReason },
    });
  }
  return { orderId: r.orderId, outcome: 'applied' };
}

/**
 * قيد الاسترداد: دائن المزوّد بالمبلغ، ومدين كل سطر دائن في البيعة (إيراد المنصة ومستحق كل مساهم) بحصته من المبلغ
 * بالقسمة بالباقي الأكبر على أوزان البيعة. حصة المساهم تُؤخذ من مستحقه المعلّق ثم المتاح، وما صُرف منه من `refund_reserve`.
 */
async function postRefund(tx: Tx, r: RefundRow, saleId: string): Promise<string> {
  const currency = r.currency as Currency;
  const lines = await tx
    .select({ kind: ledgerAccounts.kind, ownerId: ledgerAccounts.ownerId, amount: sql<string>`${postings.amountMinor}::text` })
    .from(postings)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, postings.accountId))
    .where(and(eq(postings.entryId, saleId), sql`${postings.amountMinor} < 0`))
    .orderBy(postings.id);
  const weights = lines.map((l, i) => ({ key: String(i), weight: -BigInt(l.amount) }));
  const shares = allocate(money(BigInt(r.amountMinor), currency), weights);
  const out: Array<{ account: AccountRef; amount: ReturnType<typeof money> }> = [{ account: { kind: 'provider_clearing', currency }, amount: money(-BigInt(r.amountMinor), currency) }];
  let reserve = 0n;
  const owners = [...new Set(lines.filter((l) => l.kind === 'contributor_payable').map((l) => l.ownerId!))].sort();
  // أقفال حسابات المساهمين بترتيب ثابت قبل قراءة الأرصدة، كما في reverseEntry
  const ids: string[] = [];
  for (const owner of owners) {
    for (const state of ['pending', 'available'] as PayableState[]) ids.push(await accountId(tx, { kind: 'contributor_payable', ownerId: owner, state, currency }));
  }
  if (ids.length > 0) await tx.execute(sql`SELECT 1 FROM ledger_accounts WHERE id = ANY(${`{${[...ids].sort().join(',')}}`}::uuid[]) ORDER BY id FOR UPDATE`);
  for (const [i, l] of lines.entries()) {
    let share = shares.get(String(i))!.amountMinor;
    if (share === 0n) continue;
    if (l.kind !== 'contributor_payable') {
      out.push({ account: { kind: l.kind as 'platform_revenue', currency }, amount: money(share, currency) });
      continue;
    }
    for (const state of ['pending', 'available'] as PayableState[]) {
      const have = (await payable(tx, l.ownerId!, state, currency)).amountMinor;
      const take = have < share ? have : share;
      if (take > 0n) out.push({ account: { kind: 'contributor_payable', ownerId: l.ownerId!, state, currency }, amount: money(take, currency) });
      share -= take;
      if (share === 0n) break;
    }
    reserve += share;
  }
  if (reserve > 0n) out.push({ account: { kind: 'refund_reserve', currency }, amount: money(reserve, currency) });
  const { entryId } = await postEntry(tx, {
    kind: 'refund',
    // مرجع القيد الاسترداد نفسه (للطلب أكثر من استرداد جزئي)، والطلب في تفاصيله وفي قيد البيعة المعكوس
    referenceType: 'refund',
    referenceId: r.id,
    details: { order_id: r.orderId },
    idempotencyKey: `refund:${r.id}`,
    reversesEntryId: saleId,
    actorId: null,
    postings: out,
  });
  return entryId;
}

async function toDtos(executor: Executor, rows: RefundRow[]): Promise<Refund[]> {
  if (rows.length === 0) return [];
  const items = await executor.select().from(refundItems).where(inArray(refundItems.refundId, rows.map((r) => r.id)));
  return rows.map((r) => ({
    id: r.id,
    order_id: r.orderId,
    order_item_ids: items.filter((i) => i.refundId === r.id).map((i) => i.orderItemId).sort(),
    amount: { amount_minor: Number(r.amountMinor), currency: r.currency as Currency },
    reason_code: r.reasonCode as Refund['reason_code'],
    status: r.status as Refund['status'],
    created_by: r.createdBy,
    created_at: iso(r.createdAt)!,
    completed_at: iso(r.completedAt),
  }));
}

@Controller('orders/:orderId/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @Roles('system_admin', 'finance', 'buyer_admin')
  list(@Param('orderId') orderId: string, @Req() req: Request): Promise<{ items: Refund[] }> {
    return this.refunds.list(req.principal!, orderId);
  }

  @Post()
  @Roles('system_admin', 'finance')
  create(@Param('orderId') orderId: string, @Body() body: unknown, @Req() req: Request): Promise<Refund> {
    return this.refunds.create(req.principal!, orderId, validateBody<RefundCreate>('/orders/{order_id}/refunds', 'post', body));
  }
}
