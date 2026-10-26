import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { movePayable } from '../../src/commerce/ledger';
import { PayoutWorker } from '../../src/commerce/payout.worker';
import { signWebhook } from '../../src/commerce/payment-provider';
import { money } from '../../src/commerce/money';
import { DB, type Database } from '../../src/database/database.module';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const SECRET = randomBytes(32).toString('hex');

// الاسترداد ببنوده وقواعد العمولة (العقد #333، ADR 0025 الجزءان 5 و6، ADR 0031): المبلغ مجموع البنود، والتراخيص تُبطَل
// عند الطلب، والقيد من الإشعار الموقّع وحده بنسبة حصص البيعة، وما صُرف من refund_reserve. لا مال حقيقي.
describe('refunds and commission rules (/v1/orders/{id}/refunds, /v1/commission-rules)', () => {
  let h: Harness;
  let rights: Actor;
  let finance: Actor;
  let admin: Actor;
  let reporter: string;
  beforeAll(async () => {
    h = await createHarness({ env: { PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET, SANDBOX_CHECKOUT_BASE_URL: 'http://api.test', PAYOUT_RELEASE_AFTER_DAYS: '0' } });
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    reporter = (await seedUser(h)).id;
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const post = (t: string, url: string, body: object = {}) => http().post(`/v1${url}`).set(as(t)).set('Idempotency-Key', randomUUID()).send(body);
  const template = async (type = 'editorial_single', over: Record<string, unknown> = {}) =>
    (
      await post(rights.token, '/license-templates', {
        type,
        name: { ar: 'ترخيص', en: 'License' },
        terms: { ar: 'شروط', en: 'Terms' },
        usage_media: ['web'],
        territory: { kind: 'worldwide' },
        term_days: type === 'editorial_single' ? null : 30,
        exclusivity_hours: type === 'exclusive_temporary' ? 48 : null,
        deliverables: ['original'],
        attribution: { ar: 'المصدر', en: 'Source' },
        prohibitions: [],
        base_price: { amount_minor: 10_000, currency: 'USD' },
        enabled: true,
        ...over,
      }).expect(201)
    ).body.id as string;
  // مادة قابلة للبيع ومعروضة بعروض القوالب المعطاة
  const listed = async (templates: string[]) => {
    const { materialId } = await seedUploadSession(h, reporter);
    await h.pool.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [materialId]);
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO catalog_listings (material_id, material_version, state, title_ar, title_en, description_ar, description_en, updated_by, listed_at)
       SELECT id, version, 'listed', 'عنوان', 'Title', 'وصف', 'Description', $2, now() FROM materials WHERE id = $1 RETURNING id`,
      [materialId, rights.id],
    );
    for (const t of templates) await h.pool.query(`INSERT INTO listing_offers (listing_id, license_template_id) VALUES ($1, $2)`, [rows[0]!.id, t]);
    // أصل متحقق، فيُطلب بناء حزمة التسليم عند الترخيص
    await h.pool.query(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at) VALUES ($1, 'original', 'verified', 100, $2, $3, now())`,
      [materialId, randomBytes(32), `tus/${randomUUID()}`],
    );
    return { listingId: rows[0]!.id, materialId };
  };
  const organization = async (status = 'active') => {
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email, status, verified_at, verified_by)
       VALUES ('Buyer LLC', 'مشترٍ', 'Buyer', 'JO', 'b@example.test', $1, CASE WHEN $1 = 'pending_verification' THEN NULL ELSE now() END,
               CASE WHEN $1 = 'pending_verification' THEN NULL ELSE gen_random_uuid() END) RETURNING id`,
      [status],
    );
    return rows[0]!.id;
  };
  const buyer = async (orgId: string, role: 'buyer_admin' | 'buyer_member' = 'buyer_admin') => {
    const email = `buyer-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { rows } = await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id`, [email, await hash(password), orgId]);
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, $2, 'organization', $3)`, [rows[0]!.id, role, orgId]);
    const res = await http().post('/v1/auth/login').send({ email, password }).expect(200);
    return { id: rows[0]!.id, token: res.body.access_token as string };
  };
  const ref = async (t: string, orderId: string) => {
    const s = (await post(t, `/orders/${orderId}/checkout`).expect(200)).body;
    return { session: s, ref: (s.checkout_url as string).split('/').pop()! };
  };
  const pay = (r: string, outcome = 'succeeded') => http().post(`/sandbox/checkout/${r}/${outcome}`).expect(202);
  const order = async (t: string, id: string) => (await http().get(`/v1/orders/${id}`).set(as(t)).expect(200)).body;
  const count = async (q: string, args: unknown[]) => (await h.pool.query<{ n: number }>(q, args)).rows[0]!.n;

  it('buyers of an active organization read the catalog; a pending or suspended one is 403 forbidden_scope', async () => {
    const t = await template();
    const { listingId } = await listed([t]);
    for (const role of ['buyer_admin', 'buyer_member'] as const) {
      const b = await buyer(await organization(), role);
      for (const path of ['/catalog', `/catalog/${listingId}`]) await http().get(`/v1${path}`).set(as(b.token)).expect(200);
    }
    for (const status of ['pending_verification', 'suspended']) {
      const b = await buyer(await organization(status), 'buyer_member');
      for (const path of ['/catalog', `/catalog/${listingId}`, `/catalog/${listingId}/preview-url`]) {
        expect((await http().get(`/v1${path}`).set(as(b.token)).expect(403)).body.code).toBe('forbidden_scope');
      }
    }
  });

  // طلب مدفوع ببنود من مواد مختلفة (10000 لكل بند)، ومعرّفات بنوده بترتيبها
  const paidOrder = async (n: number) => {
    const t = await template();
    const listings = [];
    for (let i = 0; i < n; i++) listings.push(await listed([t]));
    const b = await buyer(await organization());
    const created = (
      await post(b.token, '/orders', { items: listings.map((l) => ({ listing_id: l.listingId, license_template_id: t })), expected_total: { amount_minor: 10_000 * n, currency: 'USD' } }).expect(201)
    ).body;
    await pay((await ref(b.token, created.id)).ref);
    const o = await order(b.token, created.id);
    expect(o.status).toBe('paid');
    return { order: o, buyer: b, materials: listings.map((l) => l.materialId) };
  };
  const refund = (orderId: string, ids: string[], t = finance.token) => post(t, `/orders/${orderId}/refunds`, { order_item_ids: ids, reason_code: 'buyer_request' });
  const confirm = async (refundId: string) => {
    const { rows } = await h.pool.query<{ r: string }>(`SELECT provider_refund_ref AS r FROM refunds WHERE id = $1`, [refundId]);
    return http().post(`/sandbox/refunds/${rows[0]!.r}/succeeded`).expect(202);
  };
  const lines = async (refundId: string) =>
    (
      await h.pool.query(
        `SELECT a.kind, a.owner_id, a.payable_state, p.amount_minor::text AS amount FROM refunds r JOIN postings p ON p.entry_id = r.entry_id
           JOIN ledger_accounts a ON a.id = p.account_id WHERE r.id = $1 ORDER BY a.kind, a.payable_state`,
        [refundId],
      )
    ).rows;

  it('refunds one item: 201 pending, its license revoked with the event, once only; the signed notice posts the proportional entry; the last item refunds the order', async () => {
    const { order: o, buyer: b } = await paidOrder(2);
    const [first, second] = o.items as Array<{ id: string; license_id: string }>;
    const created = await refund(o.id, [first!.id]).expect(201);
    const valid = schemaValidator('Refund');
    expect(valid(created.body) ? [] : valid.errors).toEqual([]);
    expect(created.body).toMatchObject({ order_id: o.id, order_item_ids: [first!.id], amount: { amount_minor: 10_000, currency: 'USD' }, status: 'pending', completed_at: null });
    const { rows: lic } = await h.pool.query(`SELECT status, revoked_reason FROM licenses WHERE id = $1`, [first!.license_id]);
    expect(lic[0]).toEqual({ status: 'revoked', revoked_reason: 'refunded' });
    const { rows: events } = await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'license.revoked' AND aggregate_id = $1`, [first!.license_id]);
    expect(events.map((e) => Object.keys(e.payload).sort())).toEqual([['license_id', 'material_id', 'organization_id', 'revoked_reason']]);
    expect((await refund(o.id, [first!.id]).expect(409)).body.code).toBe('already_refunded');

    await confirm(created.body.id);
    await confirm(created.body.id);
    const listed = (await http().get(`/v1/orders/${o.id}/refunds`).set(as(b.token)).expect(200)).body.items;
    expect(listed).toEqual([expect.objectContaining({ id: created.body.id, status: 'succeeded', completed_at: expect.any(String) })]);
    expect(await lines(created.body.id)).toEqual([
      { kind: 'contributor_payable', owner_id: reporter, payable_state: 'pending', amount: '7000' },
      { kind: 'platform_revenue', owner_id: null, payable_state: null, amount: '3000' },
      { kind: 'provider_clearing', owner_id: null, payable_state: null, amount: '-10000' },
    ]);
    expect((await order(b.token, o.id)).status).toBe('paid');

    const rest = await refund(o.id, [second!.id], admin.token).expect(201);
    await confirm(rest.body.id);
    expect((await order(b.token, o.id)).status).toBe('refunded');
    expect(await count(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'order.status_changed' AND aggregate_id = $1 AND payload->>'status' = 'refunded'`, [o.id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'refund' AND reverses_entry_id = (SELECT id FROM journal_entries WHERE kind = 'sale' AND reference_id = $1)`, [o.id])).toBe(2);
  });

  it('a refund notice carrying the payment reference settles the oldest pending refund of that amount; the entry references the order', async () => {
    const { order: o, buyer: b } = await paidOrder(1);
    const r = await refund(o.id, [o.items[0].id]).expect(201);
    const { rows } = await h.pool.query<{ ref: string }>(`SELECT provider_ref AS ref FROM orders WHERE id = $1`, [o.id]);
    const body = Buffer.from(JSON.stringify({ event_id: `t_${randomUUID()}`, type: 'refund.succeeded', provider_ref: rows[0]!.ref, amount: { amount_minor: 10_000, currency: 'USD' }, occurred_at: new Date().toISOString() }));
    const ts = Math.floor(Date.now() / 1000);
    await http().post('/payments/webhooks/sandbox').set({ 'content-type': 'application/json', 'x-timestamp': String(ts), 'x-signature': `v1=${signWebhook(SECRET, ts, body)}` }).send(body.toString('utf8')).expect(200);
    expect((await http().get(`/v1/orders/${o.id}/refunds`).set(as(b.token)).expect(200)).body.items[0]).toMatchObject({ id: r.body.id, status: 'succeeded' });
    expect(await count(`SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'refund' AND reference_type = 'order' AND reference_id = $1 AND details->>'refund_id' = $2`, [o.id, r.body.id])).toBe(1);
    expect((await order(b.token, o.id)).status).toBe('refunded');
  });

  it('after the contributor was paid out, the refund takes the share from refund_reserve; the balance never goes below zero', async () => {
    const { order: o } = await paidOrder(1);
    const db = h.app.get<Database>(DB);
    await db.transaction((tx) =>
      movePayable(tx, { ownerId: reporter, from: 'pending', to: 'paid', amount: money(7000n, 'USD'), kind: 'payout', referenceType: 'payout', referenceId: o.id, idempotencyKey: `test-payout:${o.id}`, actorId: null }),
    );
    const before = await count(`SELECT COALESCE(sum(p.amount_minor), 0)::int AS n FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE a.kind = 'contributor_payable' AND a.owner_id = $1 AND a.payable_state = 'pending'`, [reporter]);
    const r = await refund(o.id, [o.items[0].id]).expect(201);
    await confirm(r.body.id);
    const got = await lines(r.body.id);
    const pendingTaken = got.filter((l) => l.kind === 'contributor_payable').reduce((s, l) => s + Number(l.amount), 0);
    const reserve = got.filter((l) => l.kind === 'refund_reserve').reduce((s, l) => s + Number(l.amount), 0);
    expect(pendingTaken + reserve).toBe(7000);
    expect(pendingTaken).toBeLessThanOrEqual(-before);
    const after = await count(`SELECT COALESCE(sum(p.amount_minor), 0)::int AS n FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE a.kind = 'contributor_payable' AND a.owner_id = $1 AND a.payable_state = 'pending'`, [reporter]);
    expect(after).toBeLessThanOrEqual(0);
  });

  it('refuses an unpaid order (409), an item of another order (422), and keeps buyers and other organizations out', async () => {
    const { order: o, buyer: b } = await paidOrder(1);
    const other = await paidOrder(1);
    expect((await refund(o.id, [other.order.items[0].id]).expect(422)).body.details).toEqual({ fields: ['/order_item_ids'] });
    await refund(o.id, [o.items[0].id], b.token).expect(403);
    await http().get(`/v1/orders/${o.id}/refunds`).set(as(other.buyer.token)).expect(404);
    const member = await buyer(o.organization_id, 'buyer_member');
    await http().get(`/v1/orders/${o.id}/refunds`).set(as(member.token)).expect(403);
    await refund(randomUUID(), [o.items[0].id]).expect(404);

    const t = await template();
    const { listingId } = await listed([t]);
    const unpaid = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    expect((await refund(unpaid.id, [unpaid.items[0].id]).expect(409)).body.code).toBe('order_state_conflict');
  });

  it('commission rules: versions only, the most specific rule in force at payment is frozen in the sale entry', async () => {
    const t = await template();
    const { listingId, materialId } = await listed([t]);
    const rule = (body: object, tok = admin.token) => post(tok, '/commission-rules', { license_type: null, effective_from: new Date(Date.now() - 60_000).toISOString(), ...body });
    const material = (await rule({ scope: 'material', scope_id: materialId, platform_basis_points: 5000 }).expect(201)).body;
    const valid = schemaValidator('CommissionRule');
    expect(valid(material) ? [] : valid.errors).toEqual([]);
    // قاعدة المراسل أعم من قاعدة المادة فلا تُطبَّق هنا (ولا قاعدة افتراضية تمس بقية الاختبارات في القاعدة المشتركة)
    await rule({ scope: 'reporter', scope_id: reporter, platform_basis_points: 2000 }).expect(201);
    expect((await rule({ scope: 'material', scope_id: materialId, platform_basis_points: 5000, effective_from: material.effective_from }).expect(409)).body.code).toBe('commission_rule_exists');
    expect((await rule({ scope: 'material', scope_id: 'video', platform_basis_points: 1 }).expect(422)).body.details).toEqual({ fields: ['/scope_id'] });
    expect((await rule({ scope: 'material_type', scope_id: 'not-a-type', platform_basis_points: 1 }).expect(422)).body.details).toEqual({ fields: ['/scope_id'] });
    await rule({ scope: 'material', scope_id: materialId, platform_basis_points: 1 }, finance.token).expect(403);
    // قاعدة لاحقة السريان لا تُطبَّق قبل وقتها
    await rule({ scope: 'material', scope_id: materialId, platform_basis_points: 9000, effective_from: new Date(Date.now() + 86_400_000).toISOString() }).expect(201);
    const listedRules = (await http().get('/v1/commission-rules?scope=material').set(as(finance.token)).expect(200)).body.items;
    expect(listedRules.filter((r: { scope_id: string }) => r.scope_id === materialId).map((r: { platform_basis_points: number }) => r.platform_basis_points)).toEqual([9000, 5000]);

    const b = await buyer(await organization());
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    await pay((await ref(b.token, created.id)).ref);
    const { rows } = await h.pool.query(
      `SELECT e.details, (SELECT p.amount_minor::text FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = e.id AND a.kind = 'platform_revenue') AS platform
         FROM journal_entries e WHERE e.kind = 'sale' AND e.reference_id = $1`,
      [created.id],
    );
    expect(rows[0]).toEqual({ details: { platform_basis_points: 5000, commission_rules: [material.id], item_basis_points: [5000] }, platform: '-5000' });
  });

  // Issue #389: إشعار الاسترداد وعامل التحرير على مستحق المساهم نفسه في اللحظة نفسها. قبل ترتيب الأقفال كان أحدهما يقفل «المعلّق»
  // وينتظر «المتاح» والآخر بالعكس، فيكسر Postgres أحدهما (deadlock) ويُرد الإشعار بـ 5xx. لكل جولة مساهم جديد، فترتيب
  // معرّفي حسابيه عشوائي.
  it('the refund notice and the release worker on the same contributor at once never deadlock', async () => {
    const worker = h.app.get(PayoutWorker);
    for (let round = 0; round < 12; round++) {
      reporter = (await seedUser(h)).id;
      const { order: o } = await paidOrder(1);
      // المتاح موجود قبل الجولة كما بعد أول تحرير، فيُقفل الحسابان كلاهما
      await worker.releaseDue();
      const { order: second } = await paidOrder(1);
      const created = (await refund(second.id, [second.items[0].id]).expect(201)).body;
      const [notice] = await Promise.all([confirm(created.id), worker.releaseDue(), worker.releaseDue()]);
      expect(notice.status).toBe(202);
      expect((await order(finance.token, o.id)).status).toBe('paid');
      expect(await count(`SELECT count(*)::int AS n FROM refunds WHERE id = $1 AND status = 'succeeded'`, [created.id])).toBe(1);
    }
  }, 60_000);
});
