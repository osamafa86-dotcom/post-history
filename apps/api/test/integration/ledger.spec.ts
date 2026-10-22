import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { InsufficientBalanceError, LedgerKeyConflictError, LedgerUnbalancedError, accountId, balance, movePayable, payable, postEntry, reverseEntry, type AccountRef } from '../../src/commerce/ledger';
import { money } from '../../src/commerce/money';
import { pgError } from '../../src/common/db-errors';
import { DB, type Database } from '../../src/database/database.module';
import { createHarness, type Harness, seedUser } from './harness';

// دفتر الأستاذ (ADR 0031): لكل ثابت اختبار يفشل عند كسره، واختبار مقلوب يثبت أنه يفشل بدون المحفّز أو الصلاحية
describe('ledger (double entry, append only)', () => {
  let h: Harness;
  let db: Database;
  let contributor: string;
  beforeAll(async () => {
    h = await createHarness();
    db = h.app.get(DB);
    contributor = (await seedUser(h)).id;
  });
  afterAll(() => h.close());

  const clearing: AccountRef = { kind: 'provider_clearing', currency: 'USD' };
  const revenue: AccountRef = { kind: 'platform_revenue', currency: 'USD' };
  const pending = (ownerId = contributor): AccountRef => ({ kind: 'contributor_payable', ownerId, state: 'pending', currency: 'USD' });
  const usd = (n: bigint | number) => money(n, 'USD');
  const sale = (gross: bigint, share: bigint, ownerId = contributor, key = randomUUID()) =>
    db.transaction((tx) =>
      postEntry(tx, {
        kind: 'sale',
        referenceType: 'order',
        referenceId: randomUUID(),
        details: { commission_rule_id: randomUUID(), platform_basis_points: 3000 },
        idempotencyKey: key,
        actorId: null,
        postings: [
          { account: clearing, amount: usd(gross) },
          { account: revenue, amount: usd(-(gross - share)) },
          { account: pending(ownerId), amount: usd(-share) },
        ],
      }),
    );
  const raw = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await h.pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  };
  // يكتب قيدًا مباشرة في القاعدة بسطوره ويعيد رمز الخطأ عند الإيداع (أو null إن قُبل)
  const commitRaw = (lines: Array<[string, number, string]>, opts: { kind?: string; details?: object } = {}) =>
    raw(async (c) => {
      try {
        await c.query('BEGIN');
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key, details) VALUES ($1, 'test', $2, $3, $4) RETURNING id`,
          [opts.kind ?? 'sale', randomUUID(), randomUUID(), JSON.stringify(opts.details ?? {})],
        );
        for (const [account, amount, currency] of lines) {
          await c.query(`INSERT INTO postings (entry_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4)`, [rows[0]!.id, account, amount, currency]);
        }
        await c.query('COMMIT');
        return null;
      } catch (e) {
        await c.query('ROLLBACK');
        return pgError(e).code ?? String(e);
      }
    });
  const ids = async () => {
    const a = await db.transaction((tx) => accountId(tx, clearing));
    const b = await db.transaction((tx) => accountId(tx, revenue));
    const ils = await db.transaction((tx) => accountId(tx, { kind: 'platform_revenue', currency: 'ILS' }));
    return { a, b, ils };
  };

  it('writes a balanced entry once per key; the balance is the sum of its postings, exact beyond 2^53', async () => {
    const owner = (await seedUser(h)).id;
    const key = randomUUID();
    const before = await balance(db, clearing);
    const first = await sale(10_000n, 7_000n, owner, key);
    const again = await db.transaction((tx) =>
      postEntry(tx, {
        kind: 'sale',
        referenceType: 'order',
        referenceId: randomUUID(),
        idempotencyKey: key,
        actorId: null,
        postings: [
          { account: clearing, amount: usd(1) },
          { account: revenue, amount: usd(-1) },
        ],
      }),
    ).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(LedgerKeyConflictError);
    expect(first.created).toBe(true);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM postings WHERE entry_id = $1`, [first.entryId]);
    expect(rows[0].n).toBe(3);
    expect((await payable(db, owner, 'pending', 'USD')).amountMinor).toBe(7_000n);
    expect((await balance(db, clearing)).amountMinor - before.amountMinor).toBe(10_000n);

    const big = 2n ** 60n + 7n;
    const rich = (await seedUser(h)).id;
    await sale(big, big - 3n, rich);
    expect((await payable(db, rich, 'pending', 'USD')).amountMinor).toBe(big - 3n);
  });

  it('the same key and reference returns the existing entry without new postings', async () => {
    const key = randomUUID();
    const referenceId = randomUUID();
    const entry = () =>
      db.transaction((tx) =>
        postEntry(tx, {
          kind: 'sale',
          referenceType: 'order',
          referenceId,
          idempotencyKey: key,
          actorId: null,
          postings: [
            { account: clearing, amount: usd(500) },
            { account: revenue, amount: usd(-500) },
          ],
        }),
      );
    const results = await Promise.all(Array.from({ length: 10 }, entry));
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM postings WHERE entry_id = $1`, [results[0]!.entryId]);
    expect(rows[0].n).toBe(2);
  });

  it('refuses in code, before the database, an unbalanced entry, a single posting, a zero line, or a line off its account currency', async () => {
    const post = (lines: Array<{ account: AccountRef; amount: ReturnType<typeof usd> }>) =>
      db.transaction((tx) => postEntry(tx, { kind: 'sale', referenceType: 'order', referenceId: randomUUID(), idempotencyKey: randomUUID(), actorId: null, postings: lines }));
    for (const lines of [
      [{ account: clearing, amount: usd(10) }, { account: revenue, amount: usd(-9) }],
      [{ account: clearing, amount: usd(10) }],
      [{ account: clearing, amount: usd(0) }, { account: revenue, amount: usd(0) }],
      [{ account: clearing, amount: money(10, 'ILS') }, { account: revenue, amount: money(-10, 'ILS') }],
    ]) {
      await expect(post(lines)).rejects.toBeInstanceOf(LedgerUnbalancedError);
    }
  });

  describe('database invariants (each one broken directly in SQL)', () => {
    it('balance: an unbalanced entry, a single posting and an entry without postings fail at commit (23514); a balanced one passes', async () => {
      const { a, b } = await ids();
      expect(await commitRaw([[a, 10, 'USD'], [b, -10, 'USD']])).toBeNull();
      expect(await commitRaw([[a, 10, 'USD'], [b, -9, 'USD']])).toBe('23514');
      expect(await commitRaw([[a, 10, 'USD']])).toBe('23514');
      expect(await commitRaw([])).toBe('23514');
    });

    it('currency: a posting in another currency than its account fails (23514)', async () => {
      const { a, ils } = await ids();
      expect(await commitRaw([[a, 10, 'USD'], [ils, -10, 'USD']])).toBe('23514');
    });

    it('details: free text is refused; ids, codes and numbers pass', async () => {
      const { a, b } = await ids();
      expect(await commitRaw([[a, 1, 'USD'], [b, -1, 'USD']], { details: { buyer: 'Jane Doe' } })).toBe('23514');
      expect(await commitRaw([[a, 1, 'USD'], [b, -1, 'USD']], { details: { rule_id: randomUUID(), basis_points: 3000, scope: 'material', currency: 'USD' } })).toBeNull();
    });

    it('append only: UPDATE, DELETE and TRUNCATE on entries and postings are refused (42501)', async () => {
      const { entryId } = await sale(100n, 70n);
      for (const q of [
        `UPDATE postings SET amount_minor = amount_minor * 2 WHERE entry_id = '${entryId}'`,
        `DELETE FROM postings WHERE entry_id = '${entryId}'`,
        `UPDATE journal_entries SET kind = 'correction' WHERE id = '${entryId}'`,
        `DELETE FROM journal_entries WHERE id = '${entryId}'`,
        `TRUNCATE postings`,
      ]) {
        const code = await h.pool.query(q).then(
          () => null,
          (e: unknown) => pgError(e).code,
        );
        expect([q, code]).toEqual([q, '42501']);
      }
    });

    // اختبارات مقلوبة: يُعطَّل الثابت في معاملة تُلغى، فيمر ما كان يُرفض؛ فالاختبار المقابل يقيس الثابت لا غيره
    it('mutation: with the balance triggers disabled the unbalanced entry passes, so the balance test measures them', async () => {
      const { a, b } = await ids();
      const attempt = (disable: boolean) =>
        raw(async (c) => {
          await c.query('BEGIN');
          try {
            if (disable) await c.query(`ALTER TABLE postings DISABLE TRIGGER postings_balanced; ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_balanced`);
            const { rows } = await c.query<{ id: string }>(
              `INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key) VALUES ('sale', 'test', $1, $2) RETURNING id`,
              [randomUUID(), randomUUID()],
            );
            await c.query(`INSERT INTO postings (entry_id, account_id, amount_minor, currency) VALUES ($1, $2, 10, 'USD'), ($1, $3, -9, 'USD')`, [rows[0]!.id, a, b]);
            await c.query('SET CONSTRAINTS ALL IMMEDIATE');
            return null;
          } catch (e) {
            return pgError(e).code;
          } finally {
            await c.query('ROLLBACK');
          }
        });
      expect(await attempt(false)).toBe('23514');
      expect(await attempt(true)).toBeNull();
    });

    it('append only, privilege layer: the owner holds no UPDATE, DELETE or TRUNCATE on entries and postings; granting one back shows it', async () => {
      const privileges = (c: PoolClient) =>
        // من قائمة الصلاحيات المخزنة لا من has_table_privilege، لأن المستخدم الفائق يملك كل شيء في الأخيرة
        c.query<{ ok: boolean }>(
          `SELECT c.relacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
                                               WHERE a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')) AS ok
             FROM pg_class c WHERE c.relname = 'postings'
           UNION ALL
           SELECT c.relacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
                                               WHERE a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE'))
             FROM pg_class c WHERE c.relname = 'journal_entries'`,
        ).then((r) => ({ rows: [{ ok: r.rows.some((x) => x.ok) }] }));
      await raw(async (c) => {
        await c.query('BEGIN');
        try {
          expect((await privileges(c)).rows[0]!.ok).toBe(false);
          await c.query('GRANT UPDATE ON postings TO CURRENT_USER');
          expect((await privileges(c)).rows[0]!.ok).toBe(true);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    });

    // قاعدة الاختبار يملكها مستخدم فائق يتجاوز الصلاحيات، فالمحفّز وحده يرفض هنا؛ بتعطيله يمر التعديل
    it('mutation: with the append-only trigger disabled an UPDATE passes, so the append-only test measures the trigger', async () => {
      const { entryId } = await sale(100n, 70n);
      const attempt = (disable: boolean) =>
        raw(async (c) => {
          await c.query('BEGIN');
          try {
            if (disable) await c.query('GRANT UPDATE ON postings TO CURRENT_USER; ALTER TABLE postings DISABLE TRIGGER postings_append_only');
            await c.query(`UPDATE postings SET amount_minor = amount_minor WHERE entry_id = $1`, [entryId]);
            return null;
          } catch (e) {
            return pgError(e).code;
          } finally {
            await c.query('ROLLBACK');
          }
        });
      expect(await attempt(false)).toBe('42501');
      expect(await attempt(true)).toBeNull();
    });

    it('mutation: with the currency trigger disabled a line off its account currency passes', async () => {
      const { a, ils } = await ids();
      const attempt = (disable: boolean) =>
        raw(async (c) => {
          await c.query('BEGIN');
          try {
            if (disable) await c.query('ALTER TABLE postings DISABLE TRIGGER postings_currency_matches');
            const { rows } = await c.query<{ id: string }>(
              `INSERT INTO journal_entries (kind, reference_type, reference_id, idempotency_key) VALUES ('sale', 'test', $1, $2) RETURNING id`,
              [randomUUID(), randomUUID()],
            );
            await c.query(`INSERT INTO postings (entry_id, account_id, amount_minor, currency) VALUES ($1, $2, 10, 'USD'), ($1, $3, -10, 'USD')`, [rows[0]!.id, a, ils]);
            return null;
          } catch (e) {
            return pgError(e).code;
          } finally {
            await c.query('ROLLBACK');
          }
        });
      expect(await attempt(false)).toBe('23514');
      expect(await attempt(true)).toBeNull();
    });
  });

  it('a correction reverses every line once; a second correction is refused (23505); refunds may repeat', async () => {
    const owner = (await seedUser(h)).id;
    const { entryId } = await sale(1_000n, 700n, owner);
    const correction = await db.transaction((tx) => reverseEntry(tx, { entryId, kind: 'correction', idempotencyKey: randomUUID(), actorId: null }));
    expect(correction.created).toBe(true);
    expect((await payable(db, owner, 'pending', 'USD')).amountMinor).toBe(0n);
    const second = await db.transaction((tx) => reverseEntry(tx, { entryId, kind: 'correction', idempotencyKey: randomUUID(), actorId: null })).catch((e: unknown) => pgError(e).code);
    expect(second).toBe('23505');

    const refunded = (await sale(1_000n, 700n, owner)).entryId;
    for (let i = 0; i < 2; i++) await db.transaction((tx) => reverseEntry(tx, { entryId: refunded, kind: 'refund', idempotencyKey: randomUUID(), actorId: null }));
    expect((await payable(db, owner, 'pending', 'USD')).amountMinor).toBe(-700n);
  });

  it('payable moves state by state under a row lock; never below zero, even when two payouts race; a retried payout is a no-op', async () => {
    const owner = (await seedUser(h)).id;
    await sale(200n, 100n, owner);
    const move = (from: 'pending' | 'available', to: 'available' | 'in_payout', amount: bigint, key = randomUUID()) =>
      db.transaction((tx) =>
        movePayable(tx, { ownerId: owner, from, to, amount: usd(amount), kind: from === 'pending' ? 'release' : 'payout', referenceType: 'payout', referenceId: randomUUID(), idempotencyKey: key, actorId: null }),
      );
    await move('pending', 'available', 100n);
    await expect(move('pending', 'available', 1n)).rejects.toBeInstanceOf(InsufficientBalanceError);
    const raced = await Promise.allSettled([move('available', 'in_payout', 70n), move('available', 'in_payout', 70n)]);
    expect(raced.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((raced.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientBalanceError);
    expect((await payable(db, owner, 'available', 'USD')).amountMinor).toBe(30n);
    expect((await payable(db, owner, 'in_payout', 'USD')).amountMinor).toBe(70n);

    const key = randomUUID();
    await move('available', 'in_payout', 30n, key);
    const retry = await db.transaction((tx) =>
      movePayable(tx, { ownerId: owner, from: 'available', to: 'in_payout', amount: usd(30n), kind: 'payout', referenceType: 'payout', referenceId: randomUUID(), idempotencyKey: key, actorId: null }),
    ).catch((e: unknown) => e);
    // المفتاح نفسه بمرجع آخر خطأ مستدعٍ؛ بالمرجع نفسه لا أثر (يغطيه اختبار التكرار أعلاه)
    expect(retry).toBeInstanceOf(LedgerKeyConflictError);
    expect((await payable(db, owner, 'available', 'USD')).amountMinor).toBe(0n);
  });
});
