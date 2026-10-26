import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { PAYMENT_PROVIDER } from '../../src/commerce/payment-provider';
import { StripeTestProvider, stripeSignatureHeader } from '../../src/commerce/stripe-provider';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const WHSEC = `whsec_${randomBytes(16).toString('hex')}`;
const sessions = new Map<string, { amount: number; currency: string }>();
// Stripe المسجّل: الجلسة باسم عشوائي، وقراءتها، والاسترداد
const fakeStripe = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname;
  if (init.method === 'POST' && path === '/v1/checkout/sessions') {
    const f = new URLSearchParams(init.body as string);
    const id = `cs_test_${randomBytes(8).toString('hex')}`;
    sessions.set(id, { amount: Number(f.get('line_items[0][price_data][unit_amount]')), currency: f.get('line_items[0][price_data][currency]')! });
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: Math.floor(Date.now() / 1000) + 1860 }));
  }
  return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 404 });
}) as unknown as typeof fetch;

// الشراء بمحوّل Stripe في وضع الاختبار (ADR 0032، مزوّد ثانٍ) بردود Stripe مسجّلة وتوقيعات محسوبة بسر اختباري: الجلسة
// المستضافة، وأحداث Stripe الموقّعة إلى إشعاراتنا مرة لكل evt_، وما لا يخص الدفع 200 بلا أثر. لا مال حقيقي ولا شبكة.
describe('Stripe test-mode purchase (/payments/webhooks/stripe)', () => {
  let h: Harness;
  let rights: Actor;
  let reporter: string;
  beforeAll(async () => {
    h = await createHarness({ overrides: [[PAYMENT_PROVIDER, new StripeTestProvider('sk_test_0123456789abcdef', WHSEC, 'https://stripe.test', fakeStripe)]] });
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

  const notify = (type: string, object: Record<string, unknown>, id = `evt_${randomBytes(8).toString('hex')}`, secret = WHSEC) => {
    const body = Buffer.from(JSON.stringify({ id, type, created: Math.floor(Date.now() / 1000), data: { object } }));
    return http().post('/payments/webhooks/stripe').set({ 'content-type': 'application/json', 'stripe-signature': stripeSignatureHeader(secret, body) }).send(body.toString('utf8'));
  };

  it('pays through a hosted Stripe Checkout Session; the signed completion issues the license once per event id', async () => {
    const t = await template();
    const { listingId } = await listed([t]);
    const b = await buyer(await organization());
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    const session = (await post(b.token, `/orders/${created.id}/checkout`).expect(200)).body;
    expect(session).toMatchObject({ provider: 'stripe', checkout_url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/) });
    const cs = (session.checkout_url as string).split('/').pop()!;
    expect(sessions.get(cs)).toEqual({ amount: 10_000, currency: 'usd' });

    // توقيع خاطئ قبل أي أثر، وحدث لا يخص الدفع 200 بلا تخزين
    await notify('checkout.session.completed', { id: cs, payment_status: 'paid', amount_total: 10_000, currency: 'usd' }, undefined, 'whsec_wrongwrongwrong').expect(400);
    await notify('customer.created', { id: 'cus_1' }).expect(200);
    await notify('checkout.session.completed', { id: cs, payment_status: 'unpaid', amount_total: 10_000, currency: 'usd' }).expect(200);
    expect((await order(b.token, created.id)).status).toBe('pending_payment');
    expect(await count(`SELECT count(*)::int AS n FROM payment_events WHERE provider = 'stripe' AND provider_ref = $1`, [cs])).toBe(0);

    const evt = `evt_${randomBytes(8).toString('hex')}`;
    for (let i = 0; i < 3; i++) await notify('checkout.session.completed', { id: cs, payment_status: 'paid', amount_total: 10_000, currency: 'usd' }, evt).expect(200);
    const paid = await order(b.token, created.id);
    expect(paid.status).toBe('paid');
    expect(paid.items[0].license_id).toEqual(expect.any(String));
    expect(await count(`SELECT count(*)::int AS n FROM payment_events WHERE provider = 'stripe' AND event_id = $1 AND outcome = 'applied'`, [evt])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM journal_entries WHERE kind = 'sale' AND reference_id = $1`, [created.id])).toBe(1);
    // انتهاء الجلسة بعد الدفع بلا أثر
    await notify('checkout.session.expired', { id: cs, amount_total: 10_000, currency: 'usd' }).expect(200);
    expect((await order(b.token, created.id)).status).toBe('paid');
  });

  it('an amount that does not match the order is kept for review, without a license', async () => {
    const t = await template();
    const { listingId } = await listed([t]);
    const b = await buyer(await organization());
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    const cs = ((await post(b.token, `/orders/${created.id}/checkout`).expect(200)).body.checkout_url as string).split('/').pop()!;
    await notify('checkout.session.completed', { id: cs, payment_status: 'paid', amount_total: 1, currency: 'usd' }).expect(200);
    expect((await order(b.token, created.id)).status).toBe('pending_payment');
    expect(await count(`SELECT count(*)::int AS n FROM payment_events WHERE provider_ref = $1 AND outcome = 'review'`, [cs])).toBe(1);
  });
});
