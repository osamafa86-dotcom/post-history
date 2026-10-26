import { and, eq, sql } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import type { Executor, Tx } from '../database/database.module';
import { journalEntries, ledgerAccounts, postings } from '../database/schema/schema';
import { type Currency, type Money, money, negate } from './money';

/**
 * دفتر الأستاذ (ADR 0031): قيد مزدوج لا يُعدَّل. الثوابت في القاعدة (ترحيل 029): التوازن لكل عملة عند الإيداع، وعملة
 * السطر عملة حسابه، ولا تحديث ولا حذف. وهنا ما لا تراه القاعدة: التوازن قبل الكتابة برسالة واضحة، والتكرار بمفتاح القيد،
 * والرصيد من السطور وحدها، والصرف تحت قفل صف الحساب فلا ينزل رصيد المساهم تحت الصفر.
 * المبالغ bigint في الكود ونصًا في SQL، فلا تمر برقم JavaScript في أي اتجاه.
 * الإشارة: المدين موجب. حسابات الالتزام (المستحق للمساهم، والإيراد، والرسوم، والضريبة) رصيدها الطبيعي دائن.
 */
export type PayableState = 'pending' | 'available' | 'in_payout' | 'paid';
export type AccountRef =
  | { kind: 'provider_clearing' | 'provider_fees' | 'taxes' | 'platform_revenue' | 'refund_reserve'; currency: Currency }
  | { kind: 'contributor_payable'; ownerId: string; state: PayableState; currency: Currency };

export type EntryKind = 'sale' | 'refund' | 'release' | 'payout' | 'correction';

export interface NewEntry {
  kind: EntryKind;
  referenceType: string;
  referenceId: string;
  /** أرقام ومعرّفات ورموز فقط (قيد ledger_details_is_plain)؛ للبيعة قاعدة العمولة المجمّدة. */
  details?: Record<string, unknown>;
  idempotencyKey: string;
  reversesEntryId?: string | null;
  actorId: string | null;
  postings: ReadonlyArray<{ account: AccountRef; amount: Money }>;
}

export class LedgerUnbalancedError extends Error {
  override name = 'LedgerUnbalancedError';
}

/** المفتاح نفسه لقيد آخر نوعًا أو مرجعًا: خطأ برمجي عند المستدعي، لا تكرار آمن. */
export class LedgerKeyConflictError extends Error {
  override name = 'LedgerKeyConflictError';
}

/** نقل يتجاوز مستحق المساهم في حالته. لا نقطة API للدفتر بعد؛ يترجمه مستدعيه إلى رمز العقد. */
export class InsufficientBalanceError extends Error {
  override name = 'InsufficientBalanceError';
}

/** الحساب بهويته، يُنشأ عند أول استعمال. هوية الحساب لا تتغير (محفّز)، فالمعرّف ثابت لكل هوية. */
export async function accountId(tx: Tx, ref: AccountRef): Promise<string> {
  const owner = ref.kind === 'contributor_payable' ? ref.ownerId : null;
  const state = ref.kind === 'contributor_payable' ? ref.state : null;
  const match = and(
    eq(ledgerAccounts.kind, ref.kind),
    eq(ledgerAccounts.currency, ref.currency),
    owner === null ? sql`${ledgerAccounts.ownerId} IS NULL` : eq(ledgerAccounts.ownerId, owner),
    state === null ? sql`${ledgerAccounts.payableState} IS NULL` : eq(ledgerAccounts.payableState, state),
  );
  const [found] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(match);
  if (found) return found.id;
  await tx.insert(ledgerAccounts).values({ kind: ref.kind, ownerId: owner, payableState: state, currency: ref.currency }).onConflictDoNothing();
  const [row] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(match);
  return row!.id;
}

/**
 * يكتب القيد وسطوره في معاملة المستدعي (البيعة مع حالة الترخيص وحدث Outbox). المفتاح نفسه يعيد القيد القائم دون سطور
 * جديدة، بشرط أن يكون القيد نفسه نوعًا ومرجعًا. غير المتوازن يُرفض هنا قبل القاعدة.
 */
export async function postEntry(tx: Tx, entry: NewEntry): Promise<{ entryId: string; created: boolean }> {
  if (entry.postings.length < 2) throw new LedgerUnbalancedError('a journal entry needs at least two postings');
  const totals = new Map<Currency, bigint>();
  for (const p of entry.postings) {
    if (p.amount.amountMinor === 0n) throw new LedgerUnbalancedError('a posting cannot be zero');
    if (p.amount.currency !== p.account.currency) throw new LedgerUnbalancedError('a posting must be in its account currency');
    totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? 0n) + p.amount.amountMinor);
  }
  if ([...totals.values()].some((t) => t !== 0n)) throw new LedgerUnbalancedError('a journal entry must balance in each currency');

  const [inserted] = await tx
    .insert(journalEntries)
    .values({
      kind: entry.kind,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId,
      details: entry.details ?? {},
      idempotencyKey: entry.idempotencyKey,
      reversesEntryId: entry.reversesEntryId ?? null,
      actorId: entry.actorId,
    })
    .onConflictDoNothing({ target: journalEntries.idempotencyKey })
    .returning({ id: journalEntries.id });
  if (!inserted) {
    const [existing] = await tx
      .select({ id: journalEntries.id, kind: journalEntries.kind, referenceType: journalEntries.referenceType, referenceId: journalEntries.referenceId })
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, entry.idempotencyKey));
    if (!existing || existing.kind !== entry.kind || existing.referenceType !== entry.referenceType || existing.referenceId !== entry.referenceId) {
      throw new LedgerKeyConflictError('This idempotency key belongs to another journal entry.');
    }
    return { entryId: existing.id, created: false };
  }
  for (const p of entry.postings) {
    await tx.insert(postings).values({
      entryId: inserted.id,
      accountId: await accountId(tx, p.account),
      amountMinor: sql`${p.amount.amountMinor.toString()}::bigint` as unknown as number,
      currency: p.amount.currency,
    });
  }
  return { entryId: inserted.id, created: true };
}

/** التصحيح: قيد يعكس كل سطور القيد الأصلي، مرة واحدة لكل قيد (فهرس فريد جزئي في القاعدة). */
export async function reverseEntry(
  tx: Tx,
  input: { entryId: string; kind: 'correction' | 'refund'; idempotencyKey: string; actorId: string | null; referenceType?: string; referenceId?: string },
): Promise<{ entryId: string; created: boolean }> {
  const [original] = await tx.select().from(journalEntries).where(eq(journalEntries.id, input.entryId));
  if (!original) throw ApiError.notFound();
  const lines = await tx
    .select({
      kind: ledgerAccounts.kind,
      ownerId: ledgerAccounts.ownerId,
      state: ledgerAccounts.payableState,
      currency: postings.currency,
      amount: sql<string>`${postings.amountMinor}::text`,
    })
    .from(postings)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, postings.accountId))
    .where(eq(postings.entryId, input.entryId))
    .orderBy(postings.id);
  // العكس يُنقص مستحق كل مساهم بحصته في القيد الأصلي؛ فبعد التحرير أو الصرف قد ينزل به تحت الصفر. تُقفل حسابات المساهمين
  // بترتيب ثابت (فلا تتشابك معاملتان)، ثم يُرفض العكس الذي لا يغطيه الرصيد. الاسترداد بعد الصرف يمر من refund_reserve عند مستدعيه.
  const [done] = await tx.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.idempotencyKey, input.idempotencyKey));
  if (!done) {
    const payables = lines.filter((l) => l.kind === 'contributor_payable');
    const ids = [...new Set(await Promise.all(payables.map((l) => accountId(tx, toRef(l.kind, l.ownerId, l.state, l.currency as Currency)))))].sort();
    if (ids.length > 0) await tx.execute(sql`SELECT 1 FROM ledger_accounts WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY id FOR UPDATE`);
    for (const l of payables) {
      const share = -BigInt(l.amount);
      if (share <= 0n) continue;
      const left = await payable(tx, l.ownerId!, l.state as PayableState, l.currency as Currency);
      if (left.amountMinor < share) throw new InsufficientBalanceError('The reversal exceeds the contributor balance in this state.');
    }
  }
  return postEntry(tx, {
    kind: input.kind,
    referenceType: input.referenceType ?? original.referenceType,
    referenceId: input.referenceId ?? original.referenceId,
    idempotencyKey: input.idempotencyKey,
    reversesEntryId: original.id,
    actorId: input.actorId,
    postings: lines.map((l) => ({
      account: toRef(l.kind, l.ownerId, l.state, l.currency as Currency),
      amount: negate(money(BigInt(l.amount), l.currency as Currency)),
    })),
  });
}

/** الرصيد مجموع السطور (المدين موجب). لا رصيد مخزَّن. */
export async function balance(executor: Executor, ref: AccountRef): Promise<Money> {
  const owner = ref.kind === 'contributor_payable' ? ref.ownerId : null;
  const state = ref.kind === 'contributor_payable' ? ref.state : null;
  const rows = await executor.execute<{ total: string }>(sql`
    SELECT coalesce(sum(p.amount_minor), 0)::text AS total
      FROM postings p JOIN ledger_accounts a ON a.id = p.account_id
     WHERE a.kind = ${ref.kind} AND a.currency = ${ref.currency}
       AND a.owner_id IS NOT DISTINCT FROM ${owner}::uuid AND a.payable_state IS NOT DISTINCT FROM ${state}`);
  return money(BigInt(rows.rows[0]!.total), ref.currency);
}

/** ما يستحق للمساهم في حالة بعينها، موجبًا (الرصيد الدائن معكوس الإشارة). */
export async function payable(executor: Executor, ownerId: string, state: PayableState, currency: Currency): Promise<Money> {
  return negate(await balance(executor, { kind: 'contributor_payable', ownerId, state, currency }));
}

/**
 * ينقل مستحق المساهم بين حالتين (التحرير بعد فترة الاسترداد: pending ← available، وطلب الصرف: available ← in_payout،
 * والصرف: in_payout ← paid). يقفل صف الحساب المصدر أولًا، فلا يتسابق نقلان على الرصيد نفسه، ثم يرفض ما يتجاوزه.
 */
export async function movePayable(
  tx: Tx,
  input: {
    ownerId: string;
    from: PayableState;
    to: PayableState;
    amount: Money;
    kind: 'release' | 'payout';
    referenceType: string;
    referenceId: string;
    idempotencyKey: string;
    actorId: string | null;
  },
): Promise<{ entryId: string; created: boolean }> {
  if (input.amount.amountMinor <= 0n) throw new LedgerUnbalancedError('a payable move must be positive');
  if (input.from === input.to) throw new LedgerUnbalancedError('a payable move needs two states');
  const fromRef: AccountRef = { kind: 'contributor_payable', ownerId: input.ownerId, state: input.from, currency: input.amount.currency };
  const fromId = await accountId(tx, fromRef);
  await tx.execute(sql`SELECT 1 FROM ledger_accounts WHERE id = ${fromId} FOR UPDATE`);
  const [done] = await tx.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.idempotencyKey, input.idempotencyKey));
  if (!done) {
    const available = await payable(tx, input.ownerId, input.from, input.amount.currency);
    if (available.amountMinor < input.amount.amountMinor) {
      throw new InsufficientBalanceError('The amount exceeds the contributor balance in this state.');
    }
  }
  return postEntry(tx, {
    kind: input.kind,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    idempotencyKey: input.idempotencyKey,
    actorId: input.actorId,
    postings: [
      { account: fromRef, amount: input.amount },
      { account: { ...fromRef, state: input.to }, amount: negate(input.amount) },
    ],
  });
}

function toRef(kind: string, ownerId: string | null, state: string | null, currency: Currency): AccountRef {
  if (kind === 'contributor_payable') return { kind, ownerId: ownerId!, state: state as PayableState, currency };
  return { kind: kind as Exclude<AccountRef['kind'], 'contributor_payable'>, currency };
}
