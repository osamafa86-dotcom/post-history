import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { LOGGER } from '../common/logger';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Database } from '../database/database.module';
import { payoutRequests } from '../database/schema/schema';
import { movePayable, payable } from './ledger';
import { type Currency, money } from './money';
import { amountOf, writePayoutEvent } from './payouts';

/**
 * عامل الأرباح (ADR 0031 وADR 0033)، ذاتي التكرار بمفاتيح القيود:
 * - **التحرير:** حصة المساهم من كل بيعة مضى عليها PAYOUT_RELEASE_AFTER_DAYS تنتقل من «معلّق» إلى «متاح» بقيد `release`،
 *   صافيةً مما استُرد منها، ولا تتجاوز المعلّق الحالي.
 * - **القناة التجريبية:** الطلب المعتمد يصير `processing` ثم `paid` بقيد من «قيد الصرف» إلى «مصروف». لا مال ولا بيانات حساب.
 */
@Injectable()
export class PayoutWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.OUTBOX_DISPATCHER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.PAYOUT_WORKER_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** دورة واحدة لا تتداخل مع غيرها في النسخة. */
  tick(): Promise<void> {
    if (!this.running) {
      this.running = (async () => {
        await this.releaseDue();
        await this.settleApproved();
      })()
        .catch((err: unknown) => this.logger.error({ err_name: (err as Error)?.name }, 'payout worker failed'))
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  /** يحرر ما حان تحريره، ويعيد عدد القيود المكتوبة. */
  async releaseDue(): Promise<number> {
    const due = await this.db.execute<{ sale_id: string; order_id: string; owner_id: string; currency: Currency; net: string }>(sql`
      SELECT * FROM (
        SELECT j.id AS sale_id, j.reference_id AS order_id, a.owner_id, a.currency,
               (-(SELECT coalesce(sum(p2.amount_minor), 0) FROM postings p2 JOIN journal_entries j2 ON j2.id = p2.entry_id
                   WHERE p2.account_id = a.id AND (j2.id = j.id OR j2.reverses_entry_id = j.id)))::text AS net
          FROM journal_entries j
          JOIN postings p ON p.entry_id = j.id
          JOIN ledger_accounts a ON a.id = p.account_id
         WHERE j.kind = 'sale' AND a.kind = 'contributor_payable' AND a.payable_state = 'pending'
           AND j.occurred_at <= now() - make_interval(days => ${this.config.PAYOUT_RELEASE_AFTER_DAYS})
           AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.idempotency_key = 'release:' || j.id || ':' || a.owner_id)
      ) d WHERE d.net::bigint > 0
      ORDER BY d.sale_id LIMIT 200`);
    let written = 0;
    for (const d of due.rows) {
      const done = await this.db.transaction(async (tx) => {
        const pending = (await payable(tx, d.owner_id, 'pending', d.currency)).amountMinor;
        const amount = BigInt(d.net) < pending ? BigInt(d.net) : pending;
        if (amount <= 0n) return false;
        const { created } = await movePayable(tx, {
          ownerId: d.owner_id,
          from: 'pending',
          to: 'available',
          amount: money(amount, d.currency),
          kind: 'release',
          referenceType: 'order',
          referenceId: d.order_id,
          idempotencyKey: `release:${d.sale_id}:${d.owner_id}`,
          actorId: null,
        });
        return created;
      });
      if (done) written++;
    }
    return written;
  }

  /**
   * القناة التجريبية: كل معتمد يُنفَّذ ثم يُصرف، كلٌّ في معاملته، ويعيد عدد ما صُرف. ويُستأنف ما بقي `processing` إن توقفت
   * العملية بين الخطوتين (قيد الصرف بمفتاحه مرة واحدة).
   */
  async settleApproved(): Promise<number> {
    const approved = await this.db
      .select({ id: payoutRequests.id })
      .from(payoutRequests)
      .where(inArray(payoutRequests.state, ['approved', 'processing']))
      .orderBy(asc(payoutRequests.decidedAt))
      .limit(100);
    let paid = 0;
    for (const { id } of approved) {
      await this.db.transaction(async (tx) => {
        const [row] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, id)).for('update', { skipLocked: true });
        if (!row || row.state !== 'approved') return;
        const [after] = await tx
          .update(payoutRequests)
          .set({ state: 'processing', channelRef: `sandbox_${randomBytes(12).toString('hex')}` })
          .where(eq(payoutRequests.id, id))
          .returning();
        await writePayoutEvent(tx, after!);
      });
      const done = await this.db.transaction(async (tx) => {
        const [row] = await tx.select().from(payoutRequests).where(eq(payoutRequests.id, id)).for('update', { skipLocked: true });
        if (!row || row.state !== 'processing') return false;
        const { entryId } = await movePayable(tx, {
          ownerId: row.userId,
          from: 'in_payout',
          to: 'paid',
          amount: money(await amountOf(tx, id), row.currency as Currency),
          kind: 'payout',
          referenceType: 'payout_request',
          referenceId: id,
          idempotencyKey: `payout:settle:${id}`,
          actorId: null,
        });
        const [after] = await tx
          .update(payoutRequests)
          .set({ state: 'paid', settleEntryId: entryId, completedAt: sql`now()` as unknown as string })
          .where(eq(payoutRequests.id, id))
          .returning();
        await writePayoutEvent(tx, after!);
        return true;
      });
      if (done) paid++;
    }
    return paid;
  }
}
