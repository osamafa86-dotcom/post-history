import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const SECRET = randomBytes(32).toString('hex');
const ORDER_NUMBER = /^ORD-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/;
const INVOICE_NUMBER = /^INV-(\d{4})-(\d{6,})$/;

// أرقام الطلب المقروءة (ADR 0100، ترحيل 042): رقم عشوائي عند الإنشاء، وأمر شراء اختياري يكتبه المشتري ولا يتغيّر، ورقم فاتورة
// متسلسل بلا فجوات يُعطى في معاملة تأكيد الدفع من الإشعار الموقّع وحده. لا مال حقيقي.
describe('order numbers (/v1/orders, /v1/licenses)', () => {
  let h: Harness;
  let rights: Actor;
  let reporter: string;
  let templateId: string;
  beforeAll(async () => {
    h = await createHarness({ env: { PAYMENT_PROVIDER: 'sandbox', SANDBOX_WEBHOOK_SECRET: SECRET, SANDBOX_CHECKOUT_BASE_URL: 'http://api.test' } });
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    reporter = (await seedUser(h)).id;
    templateId = (
      await post(rights.token, '/license-templates', {
        type: 'editorial_single',
        name: { ar: 'ترخيص', en: 'License' },
        terms: { ar: 'شروط', en: 'Terms' },
        usage_media: ['web'],
        territory: { kind: 'worldwide' },
        term_days: null,
        exclusivity_hours: null,
        deliverables: ['original'],
        attribution: { ar: 'المصدر', en: 'Source' },
        prohibitions: [],
        base_price: { amount_minor: 10_000, currency: 'USD' },
        enabled: true,
      }).expect(201)
    ).body.id as string;
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const post = (t: string, url: string, body: object = {}, key: string = randomUUID()) =>
    http().post(`/v1${url}`).set(as(t)).set('Idempotency-Key', key).send(body);
  const listed = async () => {
    const { materialId } = await seedUploadSession(h, reporter);
    await h.pool.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [materialId]);
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO catalog_listings (material_id, material_version, state, title_ar, title_en, description_ar, description_en, updated_by, listed_at)
       SELECT id, version, 'listed', 'عنوان تجريبي', 'Sample title', 'وصف', 'Description', $2, now() FROM materials WHERE id = $1 RETURNING id`,
      [materialId, rights.id],
    );
    await h.pool.query(`INSERT INTO listing_offers (listing_id, license_template_id) VALUES ($1, $2)`, [rows[0]!.id, templateId]);
    return rows[0]!.id;
  };
  const organization = async () => {
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email, status, verified_at, verified_by)
       VALUES ('Sample Org', 'مؤسسة تجريبية', 'Sample Org', 'JO', 'billing@example.test', 'active', now(), gen_random_uuid()) RETURNING id`,
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
  const create = (t: string, listingId: string, extra: object = {}, key?: string) =>
    post(t, '/orders', { items: [{ listing_id: listingId, license_template_id: templateId }], ...extra }, key);
  const payOrder = async (t: string, orderId: string, outcome = 'succeeded') => {
    const s = (await post(t, `/orders/${orderId}/checkout`).expect(200)).body;
    await http().post(`/sandbox/checkout/${(s.checkout_url as string).split('/').pop()!}/${outcome}`).expect(202);
  };
  const read = async (t: string, id: string) => (await http().get(`/v1/orders/${id}`).set(as(t)).expect(200)).body;
  const invoiceSeq = (n: string) => Number(INVOICE_NUMBER.exec(n)![2]);
  const validOrder = schemaValidator('Order');
  const validLicense = schemaValidator('License');

  it('gives each order a readable random number at creation, keeps the purchase order number as written, and no invoice before payment', async () => {
    const b = await buyer(await organization());
    const key = randomUUID();
    const withPo = await create(b.token, await listed(), { purchase_order_number: 'PO 2026/17-A' }, key).expect(201);
    expect(validOrder(withPo.body) ? [] : validOrder.errors).toEqual([]);
    expect(withPo.body).toMatchObject({ order_number: expect.stringMatching(ORDER_NUMBER), purchase_order_number: 'PO 2026/17-A', invoice_number: null });
    expect(withPo.body.order_number.slice(4, 8)).toBe(withPo.body.created_at.slice(0, 4));
    // التكرار بالمفتاح نفسه يعيد الطلب نفسه برقمه نفسه
    const replay = await create(b.token, (withPo.body.items[0] as { listing_id: string }).listing_id, { purchase_order_number: 'PO 2026/17-A' }, key).expect(201);
    expect(replay.body).toMatchObject({ id: withPo.body.id, order_number: withPo.body.order_number });

    const without = await create(b.token, await listed()).expect(201);
    expect(without.body).toMatchObject({ order_number: expect.stringMatching(ORDER_NUMBER), purchase_order_number: null, invoice_number: null });
    expect(without.body.order_number).not.toBe(withPo.body.order_number);
    const page = (await http().get('/v1/orders').set(as(b.token)).expect(200)).body.items as Array<{ id: string; order_number: string }>;
    expect(page.map((o) => [o.id, o.order_number])).toEqual([
      [without.body.id, without.body.order_number],
      [withPo.body.id, withPo.body.order_number],
    ]);
  });

  it('refuses a purchase order number outside the rule (422) and creates nothing', async () => {
    const b = await buyer(await organization());
    const listingId = await listed();
    for (const po of [' PO-1', 'PO-1 ', '', '-PO', 'PO\u200f1', 'PO\n1', 'أمر-1', '١٢٣', 'A'.repeat(65), 17]) {
      expect((await create(b.token, listingId, { purchase_order_number: po }).expect(422)).body.code).toBe('validation_failed');
    }
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM orders o JOIN users u ON u.id = o.created_by WHERE u.id = $1`, [b.id]);
    expect(rows[0].n).toBe(0);
    await create(b.token, listingId, { purchase_order_number: 'A'.repeat(64) }).expect(201);
  });

  it('numbers invoices at the signed confirmation alone, in sequence without gaps; cancelled and failed orders take none, and a replay changes nothing', async () => {
    const orgId = await organization();
    const b = await buyer(orgId);
    const first = await create(b.token, await listed()).expect(201);
    const cancelled = await create(b.token, await listed()).expect(201);
    const failed = await create(b.token, await listed()).expect(201);
    const second = await create(b.token, await listed()).expect(201);

    await payOrder(b.token, first.body.id);
    const paid = await read(b.token, first.body.id);
    expect(validOrder(paid) ? [] : validOrder.errors).toEqual([]);
    expect(paid).toMatchObject({ status: 'paid', invoice_number: expect.stringMatching(INVOICE_NUMBER), order_number: first.body.order_number });
    expect(INVOICE_NUMBER.exec(paid.invoice_number)![1]).toBe(paid.paid_at.slice(0, 4));

    await post(b.token, `/orders/${cancelled.body.id}/cancel`).expect(200);
    await payOrder(b.token, failed.body.id, 'failed');
    expect(await read(b.token, cancelled.body.id)).toMatchObject({ status: 'cancelled', invoice_number: null });
    expect(await read(b.token, failed.body.id)).toMatchObject({ status: 'pending_payment', invoice_number: null });

    await payOrder(b.token, second.body.id, 'duplicate');
    const next = await read(b.token, second.body.id);
    expect(invoiceSeq(next.invoice_number)).toBe(invoiceSeq(paid.invoice_number) + 1);
    // الإشعار المكرر لا يعطي رقمًا ثانيًا، والقراءة الثانية الرقم نفسه
    expect((await read(b.token, first.body.id)).invoice_number).toBe(paid.invoice_number);
    const { rows } = await h.pool.query<{ last_value: number }>(`SELECT last_value FROM invoice_counters WHERE invoice_year = $1`, [Number(paid.paid_at.slice(0, 4))]);
    expect(rows[0]!.last_value).toBe(invoiceSeq(next.invoice_number));

    // المالية ترى الأرقام نفسها؛ ولا يدخل رقم ولا أمر شراء حدثًا
    const finance = await loginAs(h, [{ role: 'finance' }]);
    expect(await read(finance.token, second.body.id)).toMatchObject({ order_number: second.body.order_number, invoice_number: next.invoice_number });
    const { rows: events } = await h.pool.query(`SELECT payload FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])`, [[first.body.id, second.body.id]]);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(Object.keys(e.payload).sort()).toEqual(['cancel_reason', 'order_id', 'organization_id', 'status']);
  });

  it('a license carries its order number, also for an organization member who did not place the order', async () => {
    const orgId = await organization();
    const admin = await buyer(orgId);
    const member = await buyer(orgId, 'buyer_member');
    const o = await create(admin.token, await listed(), { purchase_order_number: 'PO-77' }).expect(201);
    await payOrder(admin.token, o.body.id);
    const licenseId = (await read(admin.token, o.body.id)).items[0].license_id as string;
    const license = (await http().get(`/v1/licenses/${licenseId}`).set(as(admin.token)).expect(200)).body;
    expect(validLicense(license) ? [] : validLicense.errors).toEqual([]);
    expect(license).toMatchObject({ order_id: o.body.id, order_number: o.body.order_number });
    expect(JSON.stringify(license)).not.toContain('PO-77');
    // العضو لا يقرأ طلب غيره، ويرى رقمه في ترخيص مؤسسته
    await http().get(`/v1/orders/${o.body.id}`).set(as(member.token)).expect(404);
    const listed2 = (await http().get('/v1/licenses').set(as(member.token)).expect(200)).body.items as Array<{ id: string; order_number: string }>;
    expect(listed2.find((l) => l.id === licenseId)?.order_number).toBe(o.body.order_number);
  });
});
