import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PayoutWorker } from '../../src/commerce/payout.worker';
import { type AccountRef, postEntry } from '../../src/commerce/ledger';
import { type Currency, money } from '../../src/commerce/money';
import { schemaValidator } from '../../src/common/contract';
import { DB, type Database } from '../../src/database/database.module';
import { createHarness, type Harness, loginAs } from './harness';

// الأرباح وطلبات الصرف التجريبية (العقد #359، ADR 0033): التحرير بعد فترة الاسترداد، والأرصدة والكشف، والطلب بحجزه، والاعتماد
// الثنائي، والقناة التجريبية، والرفض والإلغاء بالإعادة، والسياسات. فترة الاسترداد صفر هنا فيتحرر ما بيع للتو.
describe('earnings and sandbox payouts', () => {
  let h: Harness;
  let db: Database;
  let worker: PayoutWorker;
  type Actor = Awaited<ReturnType<typeof loginAs>>;
  let finance1: Actor;
  let finance2: Actor;
  let admin: Actor;
  beforeAll(async () => {
    h = await createHarness({
      env: { PAYOUT_RELEASE_AFTER_DAYS: '0', PAYOUT_DEFAULT_MINIMUM_MINOR: '1000', PAYOUT_DEFAULT_DUAL_APPROVAL_ABOVE_MINOR: '5000', PAYOUT_DEFAULT_RESERVE_BPS: '1000' },
    });
    db = h.app.get(DB);
    worker = h.app.get(PayoutWorker);
    finance1 = await loginAs(h, [{ role: 'finance' }]);
    finance2 = await loginAs(h, [{ role: 'finance' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const post = (t: string, url: string, body: object = {}) => http().post(`/v1${url}`).set(as(t)).set('Idempotency-Key', randomUUID()).send(body);
  const get = (t: string, url: string) => http().get(`/v1${url}`).set(as(t));
  const pending = (ownerId: string, currency: Currency): AccountRef => ({ kind: 'contributor_payable', ownerId, state: 'pending', currency });
  // بيعة بحصة المساهم في «معلّق»، كما يكتبها تأكيد الدفع
  const sale = (ownerId: string, share: bigint, currency: Currency = 'USD') =>
    db.transaction((tx) =>
      postEntry(tx, {
        kind: 'sale',
        referenceType: 'order',
        referenceId: randomUUID(),
        details: { commission_rule_id: randomUUID(), platform_basis_points: 3000 },
        idempotencyKey: randomUUID(),
        actorId: null,
        postings: [
          { account: { kind: 'provider_clearing', currency }, amount: money(share * 2n, currency) },
          { account: { kind: 'platform_revenue', currency }, amount: money(-share, currency) },
          { account: pending(ownerId, currency), amount: money(-share, currency) },
        ],
      }),
    );
  const balanceOf = async (t: string, currency: Currency = 'USD') => (await get(t, '/me/earnings').expect(200)).body.balances.find((b: { currency: string }) => b.currency === currency);
  // مراسل بمتاح جاهز للطلب
  const funded = async (share: bigint, roles: Parameters<typeof loginAs>[1] = [{ role: 'reporter' }]) => {
    const r = await loginAs(h, roles);
    await sale(r.id, share);
    await worker.releaseDue();
    return r;
  };

  it('releases each sale after the refund window, net of what was refunded, once; balances and the statement come from the ledger', async () => {
    const r = await loginAs(h, [{ role: 'reporter' }]);
    const first = await sale(r.id, 7_000n);
    const before = await balanceOf(r.token);
    expect(before).toMatchObject({ pending: { amount_minor: 7_000 }, available: { amount_minor: 0 }, requestable: { amount_minor: 0 } });
    // بيعة ثانية استُرد منها ألف من «معلّق» قبل التحرير
    const second = await sale(r.id, 3_000n);
    await db.transaction((tx) =>
      postEntry(tx, {
        kind: 'refund',
        referenceType: 'order',
        referenceId: randomUUID(),
        idempotencyKey: randomUUID(),
        reversesEntryId: second.entryId,
        actorId: null,
        postings: [
          { account: pending(r.id, 'USD'), amount: money(1_000n, 'USD') },
          { account: { kind: 'provider_clearing', currency: 'USD' }, amount: money(-1_000n, 'USD') },
        ],
      }),
    );
    await worker.releaseDue();
    await worker.releaseDue();
    const summary = (await get(r.token, '/me/earnings').expect(200)).body;
    const valid = schemaValidator('EarningsSummary');
    expect(valid(summary) ? [] : valid.errors).toEqual([]);
    // 7000 + 2000 متاحًا، والاحتياطي 10% مقرَّبًا لأعلى، والحد الأدنى من السياسة الاحتياطية
    expect(summary.balances).toEqual([
      expect.objectContaining({
        currency: 'USD',
        pending: { amount_minor: 0, currency: 'USD' },
        available: { amount_minor: 9_000, currency: 'USD' },
        reserve: { amount_minor: 900, currency: 'USD' },
        requestable: { amount_minor: 8_100, currency: 'USD' },
        minimum: { amount_minor: 1_000, currency: 'USD' },
      }),
    ]);
    const releases = await h.pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'release' AND idempotency_key IN ($1, $2)`, [`release:${first.entryId}:${r.id}`, `release:${second.entryId}:${r.id}`]);
    expect(releases.rows[0].n).toBe(2);

    const page = (await get(r.token, '/me/earnings/entries?limit=100').expect(200)).body;
    const pageValid = schemaValidator('EarningsEntryPage');
    expect(pageValid(page) ? [] : pageValid.errors).toEqual([]);
    expect(page.items.map((e: { kind: string; state: string; amount: { amount_minor: number } }) => [e.kind, e.state, e.amount.amount_minor])).toEqual(
      expect.arrayContaining([
        ['sale', 'pending', 7_000],
        ['refund', 'pending', -1_000],
        ['release', 'pending', -7_000],
        ['release', 'available', 7_000],
      ]),
    );
    expect(JSON.stringify(page)).not.toMatch(/platform_basis_points|commission|buyer|organization/);
    const onlyAvailable = (await get(r.token, '/me/earnings/entries?state=available&limit=1').expect(200)).body;
    expect(onlyAvailable.items).toHaveLength(1);
    const next = (await get(r.token, `/me/earnings/entries?state=available&limit=1&cursor=${onlyAvailable.next_cursor}`).expect(200)).body;
    expect(next.items[0].id).not.toBe(onlyAvailable.items[0].id);
    await get(r.token, '/me/earnings/entries?cursor=x').expect(400);

    // المالية تقرأ أرصدة المساهم، والمراسل لا يقرأ أرصدة غيره
    expect((await get(finance1.token, `/users/${r.id}/earnings`).expect(200)).body.balances[0].available.amount_minor).toBe(9_000);
    await get(finance1.token, `/users/${randomUUID()}/earnings`).expect(404);
    await get(r.token, `/users/${r.id}/earnings`).expect(403);
    await get(finance1.token, '/me/earnings').expect(403);
  });

  it('a request holds the amount at once; below the minimum or above the requestable is 422; the owner cancels and gets it back', async () => {
    const r = await funded(5_000n);
    expect((await post(r.token, '/me/payout-requests', { amount: { amount_minor: 999, currency: 'USD' }, channel: 'sandbox' }).expect(422)).body.code).toBe('payout_below_minimum');
    // المتاح 5000 والاحتياطي 500
    expect((await post(r.token, '/me/payout-requests', { amount: { amount_minor: 4_501, currency: 'USD' }, channel: 'sandbox' }).expect(422)).body.code).toBe('insufficient_available');
    await post(r.token, '/me/payout-requests', { amount: { amount_minor: 2_000, currency: 'USD' }, channel: 'bank' }).expect(422);

    const created = (await post(r.token, '/me/payout-requests', { amount: { amount_minor: 2_000, currency: 'USD' }, channel: 'sandbox' }).expect(201)).body;
    const valid = schemaValidator('PayoutRequest');
    expect(valid(created) ? [] : valid.errors).toEqual([]);
    expect(created).toMatchObject({ user_id: r.id, state: 'requested', approvals_required: 1, approvals: [], reason_code: null, decided_at: null, completed_at: null });
    expect(await balanceOf(r.token)).toMatchObject({ available: { amount_minor: 3_000 }, in_payout: { amount_minor: 2_000 } });
    expect((await get(r.token, '/me/payout-requests').expect(200)).body.items.map((p: { id: string }) => p.id)).toContain(created.id);

    const other = await loginAs(h, [{ role: 'reporter' }]);
    await get(other.token, `/payout-requests/${created.id}`).expect(404);
    await post(other.token, `/payout-requests/${created.id}/cancel`).expect(404);
    const cancelled = (await post(r.token, `/payout-requests/${created.id}/cancel`).expect(200)).body;
    expect(cancelled).toMatchObject({ state: 'cancelled', decided_at: null, completed_at: expect.any(String) });
    expect((await post(r.token, `/payout-requests/${created.id}/cancel`).expect(409)).body.code).toBe('payout_state_conflict');
    expect(await balanceOf(r.token)).toMatchObject({ available: { amount_minor: 5_000 }, in_payout: { amount_minor: 0 } });
    // ثلاثة قيود payout مرجعها الطلب: الحجز والإعادة
    const entries = await h.pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'payout' AND reference_type = 'payout_request' AND reference_id = $1`, [created.id]);
    expect(entries.rows[0].n).toBe(2);
  });

  it('above the dual-approval limit two different approvers are needed, never the owner; the sandbox channel then pays it', async () => {
    const r = await funded(10_000n);
    const created = (await post(r.token, '/me/payout-requests', { amount: { amount_minor: 6_000, currency: 'USD' }, channel: 'sandbox' }).expect(201)).body;
    expect(created.approvals_required).toBe(2);
    await post(r.token, `/payout-requests/${created.id}/approve`).expect(403);

    const one = (await post(finance1.token, `/payout-requests/${created.id}/approve`).expect(200)).body;
    expect(one).toMatchObject({ state: 'requested', approvals: [{ approver_id: finance1.id, approved_at: expect.any(String) }] });
    expect((await post(finance1.token, `/payout-requests/${created.id}/approve`).expect(409)).body.code).toBe('already_approved');
    const two = (await post(finance2.token, `/payout-requests/${created.id}/approve`).expect(200)).body;
    expect(two).toMatchObject({ state: 'approved', decided_at: expect.any(String) });
    await worker.tick();

    const paid = (await get(r.token, `/payout-requests/${created.id}`).expect(200)).body;
    expect(paid).toMatchObject({ state: 'paid', completed_at: expect.any(String) });
    // صاحب الطلب يرى أوقات الاعتماد وحدها، والمالية المعتمدين
    expect(paid.approvals).toHaveLength(2);
    expect(paid.approvals.every((a: object) => !('approver_id' in a))).toBe(true);
    expect((await get(finance1.token, `/payout-requests/${created.id}`).expect(200)).body.approvals.map((a: { approver_id: string }) => a.approver_id).sort()).toEqual([finance1.id, finance2.id].sort());
    expect(await balanceOf(r.token)).toMatchObject({ available: { amount_minor: 4_000 }, in_payout: { amount_minor: 0 }, paid: { amount_minor: 6_000 } });
    expect((await post(finance1.token, `/payout-requests/${created.id}/reject`, { reason_code: 'policy' }).expect(409)).body.code).toBe('payout_state_conflict');

    const events = await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'payout.status_changed' AND aggregate_id = $1 ORDER BY id`, [created.id]);
    expect(events.rows.map((e) => e.payload.state)).toEqual(['requested', 'approved', 'processing', 'paid']);
    expect(Object.keys(events.rows[0].payload).sort()).toEqual(['payout_request_id', 'reason_code', 'state', 'user_id']);
    const audit = await h.pool.query(`SELECT action FROM audit_log WHERE details->>'payout_request_id' = $1 ORDER BY id`, [created.id]);
    expect(audit.rows.map((a) => a.action)).toEqual(['payout_request.created', 'payout_request.approval_added', 'payout_request.approval_added', 'payout_request.approved']);
  });

  it('finance rejects with a listed reason and the amount returns; nobody approves their own request', async () => {
    const r = await funded(3_000n);
    const created = (await post(r.token, '/me/payout-requests', { amount: { amount_minor: 1_500, currency: 'USD' }, channel: 'sandbox' }).expect(201)).body;
    await post(finance1.token, `/payout-requests/${created.id}/reject`, { reason_code: 'free text' }).expect(422);
    const rejected = (await post(finance1.token, `/payout-requests/${created.id}/reject`, { reason_code: 'documents_missing' }).expect(200)).body;
    expect(rejected).toMatchObject({ state: 'rejected', reason_code: 'documents_missing', decided_at: expect.any(String), completed_at: expect.any(String) });
    expect(await balanceOf(r.token)).toMatchObject({ available: { amount_minor: 3_000 }, in_payout: { amount_minor: 0 } });
    const finance = (await get(finance1.token, '/payout-requests?state=rejected&limit=100').expect(200)).body;
    const pageValid = schemaValidator('PayoutRequestPage');
    expect(pageValid(finance) ? [] : pageValid.errors).toEqual([]);
    expect(finance.items.map((p: { id: string }) => p.id)).toContain(created.id);
    await get(r.token, '/payout-requests').expect(403);
    await get(finance1.token, '/payout-requests?cursor=x').expect(400);

    const both = await funded(3_000n, [{ role: 'reporter' }, { role: 'finance' }]);
    const own = (await post(both.token, '/me/payout-requests', { amount: { amount_minor: 1_000, currency: 'USD' }, channel: 'sandbox' }).expect(201)).body;
    expect((await post(both.token, `/payout-requests/${own.id}/approve`).expect(409)).body.code).toBe('self_approval_forbidden');
    await post(finance1.token, `/payout-requests/${randomUUID()}/approve`).expect(404);
  });

  it('two concurrent requests cannot together exceed the requestable balance', async () => {
    const r = await funded(4_000n);
    // المتاح 4000 والقابل للطلب 3600: طلبان بـ 2000 لا يمران معًا
    const results = await Promise.all([0, 1].map(() => post(r.token, '/me/payout-requests', { amount: { amount_minor: 2_000, currency: 'USD' }, channel: 'sandbox' })));
    expect(results.map((x) => x.status).sort()).toEqual([201, 422]);
    expect(await balanceOf(r.token)).toMatchObject({ available: { amount_minor: 2_000 }, in_payout: { amount_minor: 2_000 } });
  });

  it('payout policies are append-only versions; the newest in force sets the minimum and the reserve', async () => {
    const r = await loginAs(h, [{ role: 'reporter' }]);
    await sale(r.id, 50_000n, 'ILS');
    await worker.releaseDue();
    const effective = new Date(Date.now() - 60_000).toISOString();
    const body = { currency: 'ILS', minimum: { amount_minor: 2_500, currency: 'ILS' }, dual_approval_above: { amount_minor: 100_000, currency: 'ILS' }, reserve_bps: 2000, effective_from: effective };
    await post(finance1.token, '/payout-policies', body).expect(403);
    await post(admin.token, '/payout-policies', { ...body, minimum: { amount_minor: 2_500, currency: 'USD' } }).expect(422);
    await post(admin.token, '/payout-policies', { ...body, reserve_bps: 6000 }).expect(422);
    const created = (await post(admin.token, '/payout-policies', body).expect(201)).body;
    const valid = schemaValidator('PayoutPolicy');
    expect(valid(created) ? [] : valid.errors).toEqual([]);
    expect((await post(admin.token, '/payout-policies', body).expect(409)).body.code).toBe('payout_policy_exists');
    expect((await get(finance1.token, '/payout-policies').expect(200)).body.items.map((p: { id: string }) => p.id)).toContain(created.id);
    await get(r.token, '/payout-policies').expect(403);

    expect(await balanceOf(r.token, 'ILS')).toMatchObject({ available: { amount_minor: 50_000 }, reserve: { amount_minor: 10_000 }, requestable: { amount_minor: 40_000 }, minimum: { amount_minor: 2_500 } });
    expect((await post(r.token, '/me/payout-requests', { amount: { amount_minor: 2_000, currency: 'ILS' }, channel: 'sandbox' }).expect(422)).body.code).toBe('payout_below_minimum');
  });

  it('a request left processing by a stop between the two channel steps is paid on the next cycle', async () => {
    const r = await funded(3_000n);
    const created = (await post(r.token, '/me/payout-requests', { amount: { amount_minor: 1_000, currency: 'USD' }, channel: 'sandbox' }).expect(201)).body;
    // الاعتماد والخطوة الأولى دون الثانية، كما لو توقفت العملية بينهما
    await h.pool.query(`INSERT INTO payout_approvals (payout_request_id, approver_id) VALUES ($1, $2)`, [created.id, finance1.id]);
    await h.pool.query(`UPDATE payout_requests SET state = 'approved', decided_at = now() WHERE id = $1`, [created.id]);
    await h.pool.query(`UPDATE payout_requests SET state = 'processing', channel_ref = 'sandbox_stopped' WHERE id = $1`, [created.id]);
    await worker.tick();
    expect((await get(r.token, `/payout-requests/${created.id}`).expect(200)).body.state).toBe('paid');
    expect(await balanceOf(r.token)).toMatchObject({ in_payout: { amount_minor: 0 }, paid: { amount_minor: 1_000 } });
  });
});
