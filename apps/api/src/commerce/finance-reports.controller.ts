import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { validateQuery } from '../common/contract';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import type { components } from '../generated/api';
import { Roles } from '../identity/principal';
import { type Currency, money, toContract } from './money';
import { PayoutsService } from './payouts';

type ContributorEarnings = components['schemas']['ContributorEarnings'];
type ContributorEarningsTotals = components['schemas']['ContributorEarningsTotals'];
type ContributorEarningsPage = components['schemas']['ContributorEarningsPage'];
type BuyerPurchaseTotalsPage = components['schemas']['BuyerPurchaseTotalsPage'];

/** صف مستحقات قبل الرصيد: المبالغ bigint بأصغر وحدة. */
export interface EarningsRow {
  userId: string;
  workName: string | null;
  currency: Currency;
  sales: number;
  gross: bigint;
  net: bigint;
  share: bigint;
  refunded: bigint;
  shareBasisPoints: number | null;
}

/** بداية الشهر ونهايته بتوقيت UTC (`2026-11` ← [2026-11-01، 2026-12-01)). */
export function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return [new Date(Date.UTC(y, m - 1, 1)).toISOString(), new Date(Date.UTC(y, m, 1)).toISOString()];
}

/** مجاميع الصفوف لكل عملة: البطاقات مجاميع الجدول نفسه، والنسبة رقم واحد حين تتفق الصفوف كلها. */
export function earningsTotals(rows: readonly EarningsRow[]): ContributorEarningsTotals[] {
  const by = new Map<Currency, EarningsRow[]>();
  for (const r of rows) by.set(r.currency, [...(by.get(r.currency) ?? []), r]);
  return [...by.entries()].map(([currency, list]) => {
    const sum = (f: (r: EarningsRow) => bigint) => toContract(money(list.reduce((a, r) => a + f(r), 0n), currency));
    const rates = new Set(list.map((r) => r.shareBasisPoints));
    return {
      currency,
      contributors: new Set(list.map((r) => r.userId)).size,
      sales: list.reduce((a, r) => a + r.sales, 0),
      gross: sum((r) => r.gross),
      fees_and_taxes: sum((r) => r.gross - r.net),
      net: sum((r) => r.net),
      share: sum((r) => r.share),
      refunded: sum((r) => r.refunded),
      share_basis_points: rates.size === 1 ? [...rates][0]! : null,
    };
  });
}

/**
 * قراءات مالية مجمّعة للوحة الإدارة (A4 وA5، ADR 0099)، قراءة وحدها من الدفتر والطلبات. المزوّد تجريبي (ADR 0032)، فلا رسوم
 * ولا ضريبة في القيود بعد؛ القراءة تعدّ حسابيهما إن ظهرا.
 */
@Injectable()
export class FinanceReportsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly payouts: PayoutsService,
  ) {}

  /**
   * لكل مساهم وعملة في الشهر: قيود البيع التي قُيّد له فيها، وحصته من الإجمالي والصافي بنسبة ما قُيّد له من نصيب المساهمين
   * في كل قيد (مقرّبة لكل قيد)، وما قُيّد له، وما رُدّ منه بقيود الاسترداد في الشهر.
   */
  async contributorRows(month: string, currency?: Currency): Promise<EarningsRow[]> {
    const [start, end] = monthRange(month);
    const only = currency ? sql`AND p.currency = ${currency}` : sql``;
    const { rows } = await this.db.execute<{
      user_id: string; work_name: string | null; currency: Currency; sales: number; gross: string; net: string; share: string; refunded: string; platform_bps: number | null;
    }>(sql`
      WITH lines AS (
        SELECT j.id AS entry_id, j.kind AS entry_kind, j.details, a.kind, a.owner_id, p.currency, p.amount_minor::numeric AS amount
        FROM journal_entries j
        JOIN postings p ON p.entry_id = j.id
        JOIN ledger_accounts a ON a.id = p.account_id
        WHERE j.kind IN ('sale', 'refund') AND j.occurred_at >= ${start}::timestamptz AND j.occurred_at < ${end}::timestamptz ${only}
      ), entry AS (
        SELECT l.entry_id, l.currency,
               -- مدين القيد كله سعر البيع (المزوّد ورسومه)، ودائنه المنصة والمساهمون والضريبة
               sum(l.amount) FILTER (WHERE l.amount > 0) AS gross,
               coalesce(sum(abs(l.amount)) FILTER (WHERE l.kind IN ('provider_fees', 'taxes')), 0) AS fees,
               -sum(l.amount) FILTER (WHERE l.kind = 'contributor_payable') AS pool,
               CASE WHEN jsonb_typeof(l.details -> 'platform_basis_points') = 'number'
                    THEN (l.details ->> 'platform_basis_points')::int END AS platform_bps
        FROM lines l
        WHERE l.entry_kind = 'sale'
        GROUP BY l.entry_id, l.currency, l.details
      ), credit AS (
        SELECT l.entry_id, l.owner_id, l.currency, -sum(l.amount) AS share
        FROM lines l WHERE l.entry_kind = 'sale' AND l.kind = 'contributor_payable'
        GROUP BY l.entry_id, l.owner_id, l.currency
      ), sold AS (
        SELECT c.owner_id, c.currency, count(*)::int AS sales,
               sum(round(e.gross * c.share / e.pool)) AS gross,
               sum(round((e.gross - e.fees) * c.share / e.pool)) AS net,
               sum(c.share) AS share,
               CASE WHEN count(*) FILTER (WHERE e.platform_bps IS NULL) = 0 AND count(DISTINCT e.platform_bps) = 1
                    THEN min(e.platform_bps) END AS platform_bps
        FROM credit c JOIN entry e ON e.entry_id = c.entry_id AND e.currency = c.currency
        WHERE c.share > 0 AND e.pool > 0
        GROUP BY c.owner_id, c.currency
      ), back AS (
        SELECT l.owner_id, l.currency, sum(l.amount) AS refunded
        FROM lines l WHERE l.entry_kind = 'refund' AND l.kind = 'contributor_payable' AND l.amount > 0
        GROUP BY l.owner_id, l.currency
      )
      SELECT coalesce(s.owner_id, b.owner_id) AS user_id, u.work_name, coalesce(s.currency, b.currency) AS currency,
             coalesce(s.sales, 0) AS sales, coalesce(s.gross, 0)::text AS gross, coalesce(s.net, 0)::text AS net,
             coalesce(s.share, 0)::text AS share, coalesce(b.refunded, 0)::text AS refunded, s.platform_bps
      FROM sold s FULL JOIN back b ON b.owner_id = s.owner_id AND b.currency = s.currency
      JOIN users u ON u.id = coalesce(s.owner_id, b.owner_id)`);
    return rows
      .map((r) => ({
        userId: r.user_id,
        workName: r.work_name,
        currency: r.currency,
        sales: Number(r.sales),
        gross: BigInt(r.gross),
        net: BigInt(r.net),
        share: BigInt(r.share),
        refunded: BigInt(r.refunded),
        shareBasisPoints: r.platform_bps === null ? null : 10_000 - Number(r.platform_bps),
      }))
      .sort(compareRows);
  }

  async contributorEarnings(q: { month: string; currency?: Currency; cursor?: string; limit?: number }): Promise<ContributorEarningsPage> {
    const limit = q.limit ?? 50;
    const all = await this.contributorRows(q.month, q.currency);
    const after = q.cursor === undefined ? undefined : decodeEarningsCursor(q.cursor);
    const rest = after ? all.filter((r) => compareRows(r, after) > 0) : all;
    const page = rest.slice(0, limit);
    const items: ContributorEarnings[] = [];
    for (const r of page) {
      const summary = await this.payouts.summary(r.userId);
      const zero = toContract(money(0n, r.currency));
      const balance = summary.balances.find((b) => b.currency === r.currency) ?? {
        currency: r.currency, pending: zero, available: zero, in_payout: zero, paid: zero, reserve: zero, requestable: zero, minimum: zero,
      };
      items.push({
        user_id: r.userId,
        work_name: r.workName,
        currency: r.currency,
        sales: r.sales,
        gross: toContract(money(r.gross, r.currency)),
        fees_and_taxes: toContract(money(r.gross - r.net, r.currency)),
        net: toContract(money(r.net, r.currency)),
        share: toContract(money(r.share, r.currency)),
        refunded: toContract(money(r.refunded, r.currency)),
        share_basis_points: r.shareBasisPoints,
        balance,
      });
    }
    const last = page[page.length - 1];
    return {
      month: q.month,
      items,
      totals: earningsTotals(all),
      next_cursor: rest.length > limit && last ? Buffer.from(JSON.stringify([last.share.toString(), last.userId, last.currency])).toString('base64url') : null,
    };
  }

  /** الطلبات المدفوعة في السنة لكل مؤسسة وعملة، والمسترد منها. */
  async purchaseTotals(q: { year: number; cursor?: string; limit?: number }): Promise<BuyerPurchaseTotalsPage> {
    const limit = q.limit ?? 50;
    const start = new Date(Date.UTC(q.year, 0, 1)).toISOString();
    const end = new Date(Date.UTC(q.year + 1, 0, 1)).toISOString();
    let after = sql``;
    if (q.cursor !== undefined) {
      const c = decodePurchaseCursor(q.cursor);
      after = sql`WHERE (t.organization_id, t.currency) > (${c.organizationId}::uuid, ${c.currency}::text)`;
    }
    const { rows } = await this.db.execute<{ organization_id: string; currency: Currency; paid_orders: number; paid: string; refunded: string }>(sql`
      SELECT * FROM (
        SELECT o.organization_id, o.currency, count(*)::int AS paid_orders, sum(o.total_minor)::text AS paid,
               coalesce(sum(r.refunded), 0)::text AS refunded
        FROM orders o
        LEFT JOIN LATERAL (SELECT sum(x.amount_minor) AS refunded FROM refunds x WHERE x.order_id = o.id AND x.status = 'succeeded') r ON true
        WHERE o.paid_at >= ${start}::timestamptz AND o.paid_at < ${end}::timestamptz
        GROUP BY o.organization_id, o.currency
      ) t ${after}
      ORDER BY t.organization_id, t.currency
      LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      year: q.year,
      items: page.map((r) => ({
        organization_id: r.organization_id,
        currency: r.currency,
        paid_orders: Number(r.paid_orders),
        paid: toContract(money(BigInt(r.paid), r.currency)),
        refunded: toContract(money(BigInt(r.refunded), r.currency)),
      })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.organization_id, last.currency])).toString('base64url') : null,
    };
  }
}

/** الأعلى نصيبًا أولًا، ثم المعرّف والعملة لترتيب ثابت. */
function compareRows(a: Pick<EarningsRow, 'share' | 'userId' | 'currency'>, b: Pick<EarningsRow, 'share' | 'userId' | 'currency'>): number {
  if (a.share !== b.share) return a.share > b.share ? -1 : 1;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeEarningsCursor(cursor: string): Pick<EarningsRow, 'share' | 'userId' | 'currency'> {
  try {
    const [share, userId, currency] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown, unknown];
    if (typeof share === 'string' && /^[0-9]{1,15}$/.test(share) && typeof userId === 'string' && UUID.test(userId) && (currency === 'USD' || currency === 'ILS')) {
      return { share: BigInt(share), userId, currency };
    }
  } catch {
    // يقع إلى الخطأ أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}

function decodePurchaseCursor(cursor: string): { organizationId: string; currency: Currency } {
  try {
    const [organizationId, currency] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof organizationId === 'string' && UUID.test(organizationId) && (currency === 'USD' || currency === 'ILS')) return { organizationId, currency };
  } catch {
    // يقع إلى الخطأ أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}

@Controller()
export class FinanceReportsController {
  constructor(private readonly reports: FinanceReportsService) {}

  @Get('contributor-earnings')
  @Roles('system_admin', 'finance')
  contributorEarnings(@Query() query: Record<string, unknown>): Promise<ContributorEarningsPage> {
    return this.reports.contributorEarnings(required(validateQuery<{ month?: string; currency?: Currency; cursor?: string; limit?: number }>('/contributor-earnings', 'get', query), 'month'));
  }

  @Get('buyer-purchase-totals')
  @Roles('system_admin', 'finance')
  purchaseTotals(@Query() query: Record<string, unknown>): Promise<BuyerPurchaseTotalsPage> {
    return this.reports.purchaseTotals(required(validateQuery<{ year?: number; cursor?: string; limit?: number }>('/buyer-purchase-totals', 'get', query), 'year'));
  }
}

/** المعامل الإلزامي في العقد (`required: true`)؛ validateQuery يتحقق من الأنواع لا من الحضور. */
function required<T extends object, K extends keyof T>(q: T, key: K): T & Required<Pick<T, K>> {
  if (q[key] === undefined) throw new ApiError(400, 'bad_request', 'Invalid query parameters.', { params: [key] });
  return q as T & Required<Pick<T, K>>;
}
