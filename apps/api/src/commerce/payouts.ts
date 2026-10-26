import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { pgError } from '../common/db-errors';
import { ApiError } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Database, type Executor, type Tx } from '../database/database.module';
import { auditLog, ledgerAccounts, payoutApprovals, payoutPolicies, payoutRequests, users } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import { iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { accountId, InsufficientBalanceError, movePayable, type PayableState, payable } from './ledger';
import { type Currency, CURRENCIES, money, toContract } from './money';

type EarningsSummary = components['schemas']['EarningsSummary'];
type EarningsBalance = components['schemas']['EarningsBalance'];
type EarningsEntryPage = components['schemas']['EarningsEntryPage'];
type PayoutRequest = components['schemas']['PayoutRequest'];
type PayoutRequestPage = components['schemas']['PayoutRequestPage'];
type PayoutRequestCreate = components['schemas']['PayoutRequestCreate'];
type PayoutPolicy = components['schemas']['PayoutPolicy'];
type PayoutPolicyInput = components['schemas']['PayoutPolicyInput'];
type PayoutState = components['schemas']['PayoutState'];
type PayoutReason = components['schemas']['PayoutReason'];
type RequestRow = typeof payoutRequests.$inferSelect;
type PolicyRow = typeof payoutPolicies.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN: readonly PayoutState[] = ['requested', 'approved', 'processing'];
const big = (v: bigint) => sql`${v.toString()}::bigint` as unknown as number;

/** السياسة السارية لعملة: أحدث صف لا يتجاوز الآن، وإلا السياسة الاحتياطية من الإعداد. */
export interface Policy {
  minimum: bigint;
  dualApprovalAbove: bigint;
  reserveBps: number;
}

export async function activePolicy(executor: Executor, config: AppConfig, currency: Currency): Promise<Policy> {
  const [p] = await executor
    .select()
    .from(payoutPolicies)
    .where(and(eq(payoutPolicies.currency, currency), lte(payoutPolicies.effectiveFrom, sql`now()`)))
    .orderBy(desc(payoutPolicies.effectiveFrom))
    .limit(1);
  if (p) {
    const amounts = await executor.execute<{ minimum: string; dual: string }>(
      sql`SELECT minimum_minor::text AS minimum, dual_approval_above_minor::text AS dual FROM payout_policies WHERE id = ${p.id}`,
    );
    return { minimum: BigInt(amounts.rows[0]!.minimum), dualApprovalAbove: BigInt(amounts.rows[0]!.dual), reserveBps: p.reserveBps };
  }
  return {
    minimum: BigInt(config.PAYOUT_DEFAULT_MINIMUM_MINOR),
    dualApprovalAbove: BigInt(config.PAYOUT_DEFAULT_DUAL_APPROVAL_ABOVE_MINOR),
    reserveBps: config.PAYOUT_DEFAULT_RESERVE_BPS,
  };
}

/** الاحتياطي من المتاح بنسبة السياسة، مقرَّبًا لأعلى فلا يُطلب سنت منه. */
export function reserveOf(available: bigint, bps: number): bigint {
  if (available <= 0n || bps === 0) return 0n;
  return (available * BigInt(bps) + 9_999n) / 10_000n;
}

@Injectable()
export class PayoutsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------- الأرصدة والكشف ----------

  /** الأرصدة لكل عملة لها حساب عند المساهم، محسوبة من السطور لحظة الطلب. */
  async summary(userId: string): Promise<EarningsSummary> {
    const rows = await this.db.selectDistinct({ currency: ledgerAccounts.currency }).from(ledgerAccounts).where(and(eq(ledgerAccounts.kind, 'contributor_payable'), eq(ledgerAccounts.ownerId, userId)));
    const currencies = CURRENCIES.filter((c) => rows.some((r) => r.currency === c));
    const balances: EarningsBalance[] = [];
    for (const currency of currencies) {
      const [pending, available, inPayout, paid] = await Promise.all(
        (['pending', 'available', 'in_payout', 'paid'] as PayableState[]).map((s) => payable(this.db, userId, s, currency)),
      );
      const policy = await activePolicy(this.db, this.config, currency);
      const reserve = reserveOf(available!.amountMinor, policy.reserveBps);
      const requestable = available!.amountMinor > reserve ? available!.amountMinor - reserve : 0n;
      balances.push({
        currency,
        pending: toContract(pending!),
        available: toContract(available!),
        in_payout: toContract(inPayout!),
        paid: toContract(paid!),
        reserve: toContract(money(reserve, currency)),
        requestable: toContract(money(requestable, currency)),
        minimum: toContract(money(policy.minimum, currency)),
      });
    }
    return { user_id: userId, balances, as_of: new Date().toISOString() };
  }

  /** للمالية: مساهم موجود وإلا 404. */
  async summaryOf(userId: string): Promise<EarningsSummary> {
    if (!UUID.test(userId)) throw ApiError.notFound();
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!u) throw ApiError.notFound();
    return this.summary(userId);
  }

  /** سطور قيود حسابات المساهم، الأحدث أولًا؛ المبلغ بإشارة لصاحبه (الدائن موجب). لا مشترٍ ولا سعر ولا قاعدة. */
  async entries(userId: string, q: { currency?: Currency; state?: PayableState; cursor?: string; limit?: number }): Promise<EarningsEntryPage> {
    const limit = q.limit ?? 50;
    if (q.cursor !== undefined && !/^[0-9]{1,19}$/.test(q.cursor)) throw new ApiError(400, 'bad_request', 'The cursor is invalid.');
    const rows = await this.db.execute<{ id: string; entry_id: string; kind: string; state: string; amount: string; currency: Currency; reference_type: string; reference_id: string; occurred_at: string }>(sql`
      SELECT p.id::text AS id, j.id AS entry_id, j.kind, a.payable_state AS state, (-p.amount_minor)::text AS amount, p.currency,
             j.reference_type, j.reference_id, j.occurred_at::text AS occurred_at
        FROM postings p
        JOIN ledger_accounts a ON a.id = p.account_id
        JOIN journal_entries j ON j.id = p.entry_id
       WHERE a.kind = 'contributor_payable' AND a.owner_id = ${userId}
         ${q.currency ? sql`AND p.currency = ${q.currency}` : sql``}
         ${q.state ? sql`AND a.payable_state = ${q.state}` : sql``}
         ${q.cursor ? sql`AND p.id < ${q.cursor}::bigint` : sql``}
       ORDER BY p.id DESC
       LIMIT ${limit + 1}`);
    const page = rows.rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        entry_id: r.entry_id,
        kind: r.kind as EarningsEntryPage['items'][number]['kind'],
        state: r.state as PayableState,
        amount: toContract(money(BigInt(r.amount), r.currency)),
        reference_type: r.reference_type,
        reference_id: r.reference_id,
        occurred_at: iso(r.occurred_at)!,
      })),
      next_cursor: rows.rows.length > limit ? page[page.length - 1]!.id : null,
    };
  }

  // ---------- طلبات الصرف ----------

  /**
   * طلب صرف: تحت قفل حساب «المتاح» يُحسب القابل للطلب (المتاح بعد الاحتياطي)، ثم قيد `payout` يحجز المبلغ في «قيد الصرف»
   * والطلب وحدثه وتدقيقه في المعاملة نفسها. القاعدة ترفض ما يجعل المتاح مدينًا ولو تجاوز الخادمَ طلبان.
   */
  async create(userId: string, input: PayoutRequestCreate): Promise<PayoutRequest> {
    const currency = input.amount.currency;
    const amount = BigInt(input.amount.amount_minor);
    return this.db.transaction(async (tx) => {
      const policy = await activePolicy(tx, this.config, currency);
      if (amount < policy.minimum) throw new ApiError(422, 'payout_below_minimum', 'The amount is below the payout minimum.', { minimum: toContract(money(policy.minimum, currency)) });
      const fromId = await accountId(tx, { kind: 'contributor_payable', ownerId: userId, state: 'available', currency });
      await tx.execute(sql`SELECT 1 FROM ledger_accounts WHERE id = ${fromId} FOR UPDATE`);
      const available = (await payable(tx, userId, 'available', currency)).amountMinor;
      const reserve = reserveOf(available, policy.reserveBps);
      if (amount > available - reserve) throw new ApiError(422, 'insufficient_available', 'The amount exceeds the requestable balance.');
      const id = randomUUID();
      let hold: string;
      try {
        hold = (
          await movePayable(tx, {
            ownerId: userId,
            from: 'available',
            to: 'in_payout',
            amount: money(amount, currency),
            kind: 'payout',
            referenceType: 'payout_request',
            referenceId: id,
            idempotencyKey: `payout:hold:${id}`,
            actorId: userId,
          })
        ).entryId;
      } catch (err) {
        if (err instanceof InsufficientBalanceError) throw new ApiError(422, 'insufficient_available', 'The amount exceeds the requestable balance.');
        throw err;
      }
      const [row] = await tx
        .insert(payoutRequests)
        .values({ id, userId, amountMinor: big(amount), currency, channel: input.channel, approvalsRequired: amount > policy.dualApprovalAbove ? 2 : 1, holdEntryId: hold })
        .returning();
      await this.changed(tx, row!, userId, 'payout_request.created');
      return this.dto(tx, row!, true);
    });
  }

  async listMine(userId: string, q: { cursor?: string; limit?: number }): Promise<PayoutRequestPage> {
    return this.page(eq(payoutRequests.userId, userId), q, false, true);
  }

  /** للمالية: الحالات المفتوحة الأقدم انتظارًا أولًا، وغيرها الأحدث أولًا. */
  async list(q: { state?: PayoutState; user_id?: string; cursor?: string; limit?: number }): Promise<PayoutRequestPage> {
    const where = and(q.state ? eq(payoutRequests.state, q.state) : undefined, q.user_id ? eq(payoutRequests.userId, q.user_id) : undefined);
    return this.page(where, q, q.state !== undefined && OPEN.includes(q.state), false);
  }

  /** صاحب الطلب يقرأ طلبه وحده (غيره 404)، والمالية والإدارة كل الطلبات. */
  async get(p: Principal, id: string): Promise<PayoutRequest> {
    const row = await this.find(this.db, id);
    const staff = hasRole(p, 'finance', 'system_admin');
    if (!staff && row.userId !== p.userId) throw ApiError.notFound();
    return this.dto(this.db, row, !staff);
  }

  /**
   * الاعتماد: للطلب `requested` وحده، ومن غير صاحبه، ومرة لكل معتمد (والقاعدة تفرضها). باكتمال العدد المجمّد يصير `approved`
   * وتكمله القناة التجريبية بعد المعاملة.
   */
  async approve(actorId: string, id: string): Promise<PayoutRequest> {
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.state !== 'requested') throw new ApiError(409, 'payout_state_conflict', 'Only a requested payout can be approved.');
      if (row.userId === actorId) throw new ApiError(409, 'self_approval_forbidden', 'A payout cannot be approved by its owner.');
      const [mine] = await tx.select().from(payoutApprovals).where(and(eq(payoutApprovals.payoutRequestId, id), eq(payoutApprovals.approverId, actorId)));
      if (mine) throw new ApiError(409, 'already_approved', 'This approver already approved the payout.');
      await tx.insert(payoutApprovals).values({ payoutRequestId: id, approverId: actorId });
      await this.audit(tx, actorId, 'payout_request.approval_added', row);
      const [{ n }] = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM payout_approvals WHERE payout_request_id = ${id}`)).rows as [{ n: number }];
      if (n < row.approvalsRequired) return this.dto(tx, row, false);
      const [after] = await tx.update(payoutRequests).set({ state: 'approved', decidedAt: sql`now()` as unknown as string }).where(eq(payoutRequests.id, id)).returning();
      await this.changed(tx, after!, actorId, 'payout_request.approved');
      return this.dto(tx, after!, false);
    });
  }

  /** الرفض من `requested` أو `approved` قبل التنفيذ، بسبب من القائمة؛ المبلغ يعود إلى «متاح» بقيد معاكس. */
  async reject(actorId: string, id: string, reason: PayoutReason): Promise<PayoutRequest> {
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.state !== 'requested' && row.state !== 'approved') throw new ApiError(409, 'payout_state_conflict', 'The payout can no longer be rejected.');
      const release = await this.release(tx, row, actorId);
      const [after] = await tx
        .update(payoutRequests)
        .set({ state: 'rejected', reasonCode: reason, releaseEntryId: release, decidedAt: row.decidedAt ?? (sql`now()` as unknown as string), completedAt: sql`now()` as unknown as string })
        .where(eq(payoutRequests.id, id))
        .returning();
      await this.changed(tx, after!, actorId, 'payout_request.rejected');
      return this.dto(tx, after!, false);
    });
  }

  /** صاحب الطلب يلغيه قبل اعتماده؛ غيره 404. المبلغ يعود إلى «متاح». */
  async cancel(userId: string, id: string): Promise<PayoutRequest> {
    return this.db.transaction(async (tx) => {
      const row = await this.lock(tx, id);
      if (row.userId !== userId) throw ApiError.notFound();
      if (row.state !== 'requested') throw new ApiError(409, 'payout_state_conflict', 'Only a requested payout can be cancelled.');
      const release = await this.release(tx, row, userId);
      const [after] = await tx
        .update(payoutRequests)
        .set({ state: 'cancelled', releaseEntryId: release, completedAt: sql`now()` as unknown as string })
        .where(eq(payoutRequests.id, id))
        .returning();
      await this.changed(tx, after!, userId, 'payout_request.cancelled');
      return this.dto(tx, after!, true);
    });
  }

  // ---------- السياسات ----------

  async policies(): Promise<{ items: PayoutPolicy[] }> {
    const rows = await this.db.select().from(payoutPolicies).orderBy(desc(payoutPolicies.effectiveFrom), desc(payoutPolicies.id));
    return { items: await Promise.all(rows.map((r) => this.policyDto(this.db, r))) };
  }

  /** إصدار جديد لا يعدّل سابقه؛ عملتا المبلغين عملة السياسة (422)، والعملة والتاريخ نفسيهما 409. */
  async createPolicy(actorId: string, input: PayoutPolicyInput): Promise<PayoutPolicy> {
    const wrong = [input.minimum.currency !== input.currency && '/minimum/currency', input.dual_approval_above.currency !== input.currency && '/dual_approval_above/currency'].filter(Boolean) as string[];
    if (wrong.length > 0) throw ApiError.validation({ fields: wrong });
    return this.db.transaction(async (tx) => {
      let row: PolicyRow;
      try {
        row = await tx.transaction(async (sp) => {
          const [r] = await sp
            .insert(payoutPolicies)
            .values({
              currency: input.currency,
              minimumMinor: big(BigInt(input.minimum.amount_minor)),
              dualApprovalAboveMinor: big(BigInt(input.dual_approval_above.amount_minor)),
              reserveBps: input.reserve_bps,
              effectiveFrom: input.effective_from,
              createdBy: actorId,
            })
            .returning();
          return r!;
        });
      } catch (err) {
        if (pgError(err).constraint === 'payout_policies_key') throw new ApiError(409, 'payout_policy_exists', 'A payout policy for this currency and date exists.');
        throw err;
      }
      await tx.insert(auditLog).values({ actorId, action: 'payout_policy.created', targetType: 'payout_policy', targetId: row.id, details: { policy_id: row.id }, hash: Buffer.alloc(32) });
      return this.policyDto(tx, row);
    });
  }

  // ---------- داخلي ----------

  private async find(executor: Executor, id: string): Promise<RequestRow> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [row] = await executor.select().from(payoutRequests).where(eq(payoutRequests.id, id));
    if (!row) throw ApiError.notFound();
    return row;
  }

  private async lock(tx: Tx, id: string): Promise<RequestRow> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [row] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, id)).for('update');
    if (!row) throw ApiError.notFound();
    return row;
  }

  /** الإعادة إلى «متاح» بقيد payout مرجعه الطلب. */
  private async release(tx: Tx, row: RequestRow, actorId: string): Promise<string> {
    const { entryId } = await movePayable(tx, {
      ownerId: row.userId,
      from: 'in_payout',
      to: 'available',
      amount: money(await amountOf(tx, row.id), row.currency as Currency),
      kind: 'payout',
      referenceType: 'payout_request',
      referenceId: row.id,
      idempotencyKey: `payout:release:${row.id}`,
      actorId,
    });
    return entryId;
  }

  private async changed(tx: Tx, row: RequestRow, actorId: string, action: string): Promise<void> {
    await writePayoutEvent(tx, row);
    await this.audit(tx, actorId, action, row);
  }

  private async audit(tx: Tx, actorId: string, action: string, row: RequestRow): Promise<void> {
    await tx.insert(auditLog).values({
      actorId,
      action,
      targetType: 'payout_request',
      targetId: row.id,
      details: { payout_request_id: row.id, target_user_id: row.userId, ...(row.reasonCode ? { reason_code: row.reasonCode } : {}) },
      hash: Buffer.alloc(32),
    });
  }

  private async page(where: ReturnType<typeof and>, q: { cursor?: string; limit?: number }, oldestFirst: boolean, owner: boolean): Promise<PayoutRequestPage> {
    const limit = q.limit ?? 50;
    let after: { at: string; id: string } | null = null;
    if (q.cursor) {
      try {
        const [at, id] = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as [unknown, unknown];
        if (typeof at !== 'string' || typeof id !== 'string' || !UUID.test(id) || Number.isNaN(Date.parse(at))) throw new Error('cursor');
        after = { at, id };
      } catch {
        throw new ApiError(400, 'bad_request', 'The cursor is invalid.');
      }
    }
    const cmp = oldestFirst ? sql`>` : sql`<`;
    const rows = await this.db
      .select({ row: payoutRequests, at: sql<string>`${payoutRequests.requestedAt}::text` })
      .from(payoutRequests)
      .where(and(where, after ? sql`(${payoutRequests.requestedAt}, ${payoutRequests.id}) ${cmp} (${after.at}::timestamptz, ${after.id}::uuid)` : undefined))
      .orderBy(...(oldestFirst ? [asc(payoutRequests.requestedAt), asc(payoutRequests.id)] : [desc(payoutRequests.requestedAt), desc(payoutRequests.id)]))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await Promise.all(page.map((r) => this.dto(this.db, r.row, owner))),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.at, last.row.id])).toString('base64url') : null,
    };
  }

  /** المعتمدون بمعرّفاتهم للمالية والإدارة، وبأوقاتهم وحدها لصاحب الطلب. */
  private async dto(executor: Executor, r: RequestRow, owner: boolean): Promise<PayoutRequest> {
    const approvals = await executor.select().from(payoutApprovals).where(eq(payoutApprovals.payoutRequestId, r.id)).orderBy(asc(payoutApprovals.approvedAt));
    return {
      id: r.id,
      user_id: r.userId,
      amount: toContract(money(await amountOf(executor, r.id), r.currency as Currency)),
      channel: r.channel as PayoutRequest['channel'],
      state: r.state as PayoutState,
      reason_code: (r.reasonCode as PayoutReason | null) ?? null,
      approvals_required: r.approvalsRequired as 1 | 2,
      approvals: approvals.map((a) => (owner ? { approved_at: iso(a.approvedAt)! } : { approver_id: a.approverId, approved_at: iso(a.approvedAt)! })),
      requested_at: iso(r.requestedAt)!,
      decided_at: iso(r.decidedAt),
      completed_at: iso(r.completedAt),
    };
  }

  private async policyDto(executor: Executor, r: PolicyRow): Promise<PayoutPolicy> {
    const [a] = (
      await executor.execute<{ minimum: string; dual: string }>(sql`SELECT minimum_minor::text AS minimum, dual_approval_above_minor::text AS dual FROM payout_policies WHERE id = ${r.id}`)
    ).rows;
    const currency = r.currency as Currency;
    return {
      id: r.id,
      currency,
      minimum: toContract(money(BigInt(a!.minimum), currency)),
      dual_approval_above: toContract(money(BigInt(a!.dual), currency)),
      reserve_bps: r.reserveBps,
      effective_from: iso(r.effectiveFrom)!,
      created_by: r.createdBy,
      created_at: iso(r.createdAt)!,
    };
  }
}

/** مبلغ الطلب نصًا من القاعدة إلى bigint، فلا يمر برقم JavaScript. */
export async function amountOf(executor: Executor, id: string): Promise<bigint> {
  const res = await executor.execute<{ amount: string }>(sql`SELECT amount_minor::text AS amount FROM payout_requests WHERE id = ${id}`);
  return BigInt(res.rows[0]!.amount);
}

export async function writePayoutEvent(tx: Tx, row: RequestRow): Promise<void> {
  await writeOutboxEvent(tx, {
    type: 'payout.status_changed',
    aggregateType: 'payout',
    aggregateId: row.id,
    idempotencyKey: `payout.status_changed:${row.id}:${row.state}`,
    payload: { payout_request_id: row.id, user_id: row.userId, state: row.state, reason_code: row.reasonCode },
  });
}

