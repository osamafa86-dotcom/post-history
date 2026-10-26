import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { signWebhook } from '../../src/commerce/payment-provider';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const SECRET = randomBytes(32).toString('hex');

// الشراء بالمزوّد التجريبي (العقد v0.3 الجزء 4، ADR 0031 و0032): الطلب يجمّد العرض، والدفع من الإشعار الموقّع وحده،
// والتأكيد في معاملة واحدة: الترخيص وقيد البيعة والأحداث. التكرار بلا أثر، والحصرية بحجز واحد. لا مال حقيقي.
describe('sandbox purchase (/v1/orders, /payments/webhooks/sandbox)', () => {
  let h: Harness;
  let rights: Actor;
  let reporter: string;
  beforeAll(async () => {
    h = await createHarness({ env: { PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET, SANDBOX_CHECKOUT_BASE_URL: 'http://api.test' } });
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
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

  it('a paid order issues its license, posts the sale entry and its events once, in the contract shape', async () => {
    const t = await template();
    const { listingId, materialId } = await listed([t]);
    const b = await buyer(await organization());
    const created = await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }], expected_total: { amount_minor: 10_000, currency: 'USD' } }).expect(201);
    const valid = schemaValidator('Order');
    expect(valid(created.body) ? [] : valid.errors).toEqual([]);
    expect(created.body).toMatchObject({ status: 'pending_payment', total: { amount_minor: 10_000, currency: 'USD' }, items: [{ listing_id: listingId, license_version: 1, license_id: null }] });
    expect(JSON.stringify(created.body)).not.toContain(materialId);

    const { session, ref: r } = await ref(b.token, created.body.id);
    expect(session).toMatchObject({ provider: 'sandbox', checkout_url: expect.stringMatching(/^http:\/\/api\.test\/sandbox\/checkout\//) });
    expect((await ref(b.token, created.body.id)).ref).toBe(r);
    expect((await http().get(`/sandbox/checkout/${r}`).expect(200)).text).toContain('100.00 USD');

    await pay(r, 'duplicate');
    const paid = await order(b.token, created.body.id);
    expect(paid).toMatchObject({ status: 'paid', paid_at: expect.any(String) });
    const licenseId = paid.items[0].license_id as string;
    const { rows: lic } = await h.pool.query(`SELECT license_number, status, organization_id FROM licenses WHERE id = $1`, [licenseId]);
    expect(lic[0]).toMatchObject({ status: 'active', license_number: expect.stringMatching(/^PH-\d{4}-[0-9A-HJKMNP-TV-Z]{10}$/) });
    expect(await count(`SELECT count(*)::int AS n FROM licenses l JOIN order_items i ON i.id = l.order_item_id WHERE i.order_id = $1`, [created.body.id])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1 AND outcome = 'applied'`, [created.body.id])).toBe(1);

    // قيد البيعة: الإجمالي مدين على المزوّد، و30% للمنصة، و70% معلّقة للمراسل
    const { rows: lines } = await h.pool.query(
      `SELECT a.kind, a.owner_id, a.payable_state, p.amount_minor::text AS amount FROM journal_entries e JOIN postings p ON p.entry_id = e.id
         JOIN ledger_accounts a ON a.id = p.account_id WHERE e.reference_id = $1 ORDER BY p.id`,
      [created.body.id],
    );
    expect(lines).toEqual([
      { kind: 'provider_clearing', owner_id: null, payable_state: null, amount: '10000' },
      { kind: 'platform_revenue', owner_id: null, payable_state: null, amount: '-3000' },
      { kind: 'contributor_payable', owner_id: reporter, payable_state: 'pending', amount: '-7000' },
    ]);
    const { rows: events } = await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = ANY($1::uuid[]) ORDER BY id`, [[created.body.id, licenseId]]);
    expect(events.map((e) => [e.type, e.payload.status ?? null])).toEqual([
      ['order.status_changed', 'pending_payment'],
      ['order.status_changed', 'paid'],
      ['license.issued', null],
      ['license.delivery_requested', null],
    ]);
    expect(JSON.stringify(events)).not.toContain('Buyer LLC');

    // نجاح ثم فشل بمعرّفين (خارج الترتيب) لا يغيّر الطلب المدفوع
    await pay(r, 'out_of_order');
    expect((await order(b.token, created.body.id)).status).toBe('paid');
  });

  it('the webhook verifies the raw body before anything: a bad or stale signature is 400, an unknown provider 404, an unknown reference 200 without effect', async () => {
    const body = Buffer.from(JSON.stringify({ event_id: `e_${randomUUID()}`, type: 'payment.succeeded', provider_ref: 'sbx_unknown', amount: { amount_minor: 1, currency: 'USD' }, occurred_at: new Date().toISOString() }));
    const send = (b: Buffer, ts: number, key = SECRET, provider = 'sandbox') =>
      http().post(`/payments/webhooks/${provider}`).set('Content-Type', 'application/json').set('X-Timestamp', String(ts)).set('X-Signature', `v1=${signWebhook(key, ts, b)}`).send(b.toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    expect((await send(body, now, randomBytes(32).toString('hex')).expect(400)).body.code).toBe('webhook_signature_invalid');
    expect((await send(body, now - 600).expect(400)).body.code).toBe('webhook_signature_invalid');
    await send(body, now, SECRET, 'stripe').expect(404);
    expect((await send(body, now).expect(200)).body).toEqual({ received: true });
    const { rows } = await h.pool.query(`SELECT outcome, order_id FROM payment_events WHERE provider_ref = 'sbx_unknown'`);
    expect(rows).toEqual([{ outcome: 'ignored', order_id: null }]);
  });

  it('exclusivity: one hold per material; a second exclusive or a non-exclusive sale under the hold is 409; cancelling releases it', async () => {
    const ex = await template('exclusive_temporary');
    const plain = await template();
    const { listingId } = await listed([ex, plain]);
    const a = await buyer(await organization());
    const b = await buyer(await organization());
    const first = await post(a.token, '/orders', { items: [{ listing_id: listingId, license_template_id: ex }] }).expect(201);
    expect(new Date(first.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    expect((await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: ex }] }).expect(409)).body.code).toBe('exclusive_unavailable');
    expect((await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: plain }] }).expect(409)).body.code).toBe('exclusive_unavailable');
    const cancelled = await post(a.token, `/orders/${first.body.id}/cancel`).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancel_reason: 'buyer' });
    await post(a.token, `/orders/${first.body.id}/checkout`).expect(409);
    const second = await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: ex }] }).expect(201);
    await pay((await ref(b.token, second.body.id)).ref);
    const { rows } = await h.pool.query(`SELECT state FROM exclusive_holds h JOIN order_items i ON i.id = h.order_item_id WHERE i.order_id = $1`, [second.body.id]);
    expect(rows).toEqual([{ state: 'active' }]);
    // بعد البيع الحصري لا حجز جديد ولا بيع غير حصري
    expect((await post(a.token, '/orders', { items: [{ listing_id: listingId, license_template_id: plain }] }).expect(409)).body.code).toBe('exclusive_unavailable');
  });

  it('refuses mixed currencies (422), a changed total (409), an unavailable offer (409), a pending organization (403); isolates organizations and members', async () => {
    const usd = await template();
    const ils = await template('editorial_single', { base_price: { amount_minor: 5_000, currency: 'ILS' } });
    const one = await listed([usd]);
    const two = await listed([ils]);
    const orgId = await organization();
    const admin = await buyer(orgId);
    const member = await buyer(orgId, 'buyer_member');
    expect((await post(admin.token, '/orders', { items: [{ listing_id: one.listingId, license_template_id: usd }, { listing_id: two.listingId, license_template_id: ils }] }).expect(422)).body.code).toBe('mixed_currency');
    expect((await post(admin.token, '/orders', { items: [{ listing_id: one.listingId, license_template_id: usd }], expected_total: { amount_minor: 1, currency: 'USD' } }).expect(409)).body.code).toBe('price_changed');
    expect((await post(admin.token, '/orders', { items: [{ listing_id: one.listingId, license_template_id: ils }] }).expect(409)).body.code).toBe('listing_unavailable');
    const pending = await buyer(await organization('pending_verification'));
    expect((await post(pending.token, '/orders', { items: [{ listing_id: one.listingId, license_template_id: usd }] }).expect(403)).body.code).toBe('forbidden_scope');

    const mine = await post(member.token, '/orders', { items: [{ listing_id: one.listingId, license_template_id: usd }] }).expect(201);
    const theirs = await post(admin.token, '/orders', { items: [{ listing_id: two.listingId, license_template_id: ils }] }).expect(201);
    const memberList = (await http().get('/v1/orders').set(as(member.token)).expect(200)).body.items.map((o: { id: string }) => o.id);
    expect(memberList).toEqual([mine.body.id]);
    await http().get(`/v1/orders/${theirs.body.id}`).set(as(member.token)).expect(404);
    const outsider = await buyer(await organization());
    await http().get(`/v1/orders/${mine.body.id}`).set(as(outsider.token)).expect(404);
    await post(outsider.token, `/orders/${mine.body.id}/checkout`).expect(404);
  });

  it('a payment for the wrong amount, or after the rights changed, issues no license and is kept for review', async () => {
    const t = await template();
    const a = await listed([t]);
    const b = await buyer(await organization());
    const wrong = await post(b.token, '/orders', { items: [{ listing_id: a.listingId, license_template_id: t }] }).expect(201);
    const { ref: r } = await ref(b.token, wrong.body.id);
    const body = Buffer.from(JSON.stringify({ event_id: `e_${randomUUID()}`, type: 'payment.succeeded', provider_ref: r, amount: { amount_minor: 1, currency: 'USD' }, occurred_at: new Date().toISOString() }));
    const ts = Math.floor(Date.now() / 1000);
    await http().post('/payments/webhooks/sandbox').set('Content-Type', 'application/json').set('X-Timestamp', String(ts)).set('X-Signature', `v1=${signWebhook(SECRET, ts, body)}`).send(body.toString('utf8')).expect(200);
    expect((await order(b.token, wrong.body.id)).status).toBe('pending_payment');
    expect(await count(`SELECT count(*)::int AS n FROM payment_events WHERE order_id = $1 AND outcome = 'review'`, [wrong.body.id])).toBe(1);

    const c = await listed([t]);
    const changed = await post(b.token, '/orders', { items: [{ listing_id: c.listingId, license_template_id: t }] }).expect(201);
    const { ref: r2 } = await ref(b.token, changed.body.id);
    await h.pool.query(`UPDATE catalog_listings SET state = 'suspended', suspended_reason = 'rights_changed' WHERE id = $1`, [c.listingId]);
    await h.pool.query(`UPDATE materials SET rights_state = 'documented' WHERE id = $1`, [c.materialId]);
    await pay(r2);
    expect(await order(b.token, changed.body.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'rights_changed' });
    expect(await count(`SELECT count(*)::int AS n FROM licenses l JOIN order_items i ON i.id = l.order_item_id WHERE i.order_id = $1`, [changed.body.id])).toBe(0);
  });
});
