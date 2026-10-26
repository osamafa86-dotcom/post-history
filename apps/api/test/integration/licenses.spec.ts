import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { Readable } from 'node:stream';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const SECRET = randomBytes(32).toString('hex');

class SigningStorage implements ObjectStorage {
  async head() {
    return null;
  }
  async read() {
    return Readable.from([]);
  }
  presignGet(bucket: string, key: string, expiresSeconds: number) {
    return `https://storage.test/${bucket}/${key}?X-Amz-Expires=${expiresSeconds}&X-Amz-Signature=sig`;
  }
}

// التراخيص الصادرة ورابط تنزيل حزمتها (العقد #303، ADR 0025 الجزءان 4 و9): عزل المؤسسات، ورابط موقّع قصير العمر لا يُحفظ،
// ومنح تُحصى بقفل صف الترخيص. وعودة صفحة الدفع التجريبية إلى صفحة الويب المعدّة وحدها.
describe('licenses (/v1/licenses) and the sandbox return', () => {
  let h: Harness;
  let rights: Actor;
  let finance: Actor;
  let reporter: string;
  beforeAll(async () => {
    h = await createHarness({
      env: {
        PAYMENT_PROVIDER: 'sandbox',
        SANDBOX_WEBHOOK_SECRET: SECRET,
        SANDBOX_CHECKOUT_BASE_URL: 'http://api.test',
        SANDBOX_RETURN_URL: 'https://web.example/ar/orders/{order_id}',
        LICENSE_DOWNLOAD_LIMIT: '2',
        LICENSE_DOWNLOAD_URL_SECONDS: '600',
        LICENSE_VERIFY_RATE_LIMIT_MAX: '6',
      },
      overrides: [[OBJECT_STORAGE, new SigningStorage()]],
    });
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
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

  // ترخيص مدفوع لمؤسسة جديدة، وحزمة تسليمه متحققة إن طُلب
  const licensed = async (withDelivery = true) => {
    const t = await template();
    const { listingId, materialId } = await listed([t]);
    const orgId = await organization();
    const b = await buyer(orgId);
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    await pay((await ref(b.token, created.id)).ref);
    const licenseId = (await order(b.token, created.id)).items[0].license_id as string;
    if (withDelivery) {
      const { rows } = await h.pool.query<{ id: string }>(`SELECT id FROM material_files WHERE material_id = $1 AND kind = 'original'`, [materialId]);
      await h.pool.query(
        `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at, derived_from_id, license_id)
         VALUES ($1, 'delivery', 'verified', 100, $2, $3, now(), $4, $5)`,
        [materialId, randomBytes(32), `delivery/${licenseId}/package.zip`, rows[0]!.id, licenseId],
      );
    }
    return { licenseId, orgId, buyer: b, listingId, orderId: created.id as string };
  };
  const download = (t: string, id: string, key = randomUUID()) => http().post(`/v1/licenses/${id}/download-url`).set(as(t)).set('Idempotency-Key', key).send();

  it('buyer routes never disclose staff work names or fingerprints; buyers reject work-name with 422', async () => {
    const a = await licensed();
    const admin = await loginAs(h, [{role:'system_admin'}]);
    const name = 'اسم عمل اصطناعي خاص';
    await h.pool.query(`UPDATE users SET work_name = $2 WHERE id = $1`, [admin.id, name]);
    await http().put(`/v1/users/${a.buyer.id}/work-name`).set(as(admin.token)).set('Idempotency-Key', randomUUID()).send({ work_name: name }).expect(422);
    const license = (await http().get(`/v1/licenses/${a.licenseId}`).set(as(a.buyer.token)).expect(200)).body;
    for (const path of ['/catalog', `/catalog/${a.listingId}`, '/orders', `/orders/${a.orderId}`, '/licenses', `/licenses/${a.licenseId}`]) {
      const response = await http().get(`/v1${path}`).set(as(a.buyer.token)).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toContain(name);
      expect(text).not.toMatch(/"(?:work_name|actor_name|reserved_by_name|sha256|fingerprint|head_sha256|tail_sha256)"/);
    }
  });

  it('active exclusivity exposes its end alone and matches availability filters', async () => {
    const t = await template('exclusive_temporary');
    const {listingId} = await listed([t]); const b = await buyer(await organization());
    const pending = (await post(b.token,'/orders',{items:[{listing_id:listingId,license_template_id:t}]}).expect(201)).body;
    const catalog = async () => (await http().get(`/v1/catalog/${listingId}`).set(as(b.token)).expect(200)).body;
    expect(await catalog()).toMatchObject({exclusive_available:false,exclusive_unavailable_until:null});
    await pay((await ref(b.token,pending.id)).ref);
    const licenseId = (await order(b.token,pending.id)).items[0].license_id;
    const license = (await http().get(`/v1/licenses/${licenseId}`).set(as(b.token)).expect(200)).body;
    expect(await catalog()).toMatchObject({exclusive_available:false,exclusive_unavailable_until:license.exclusive_until});
    const available = (await http().get('/v1/catalog?exclusive_available=true').set(as(b.token)).expect(200)).body.items;
    expect(available.some((i: {listing_id:string})=>i.listing_id===listingId)).toBe(false);
  });

  it('lists and reads licenses in the contract shape, an organization sees its own only, staff sees all and filters', async () => {
    const a = await licensed();
    const other = await licensed();
    const member = await buyer(a.orgId, 'buyer_member');
    const page = (await http().get('/v1/licenses').set(as(member.token)).expect(200)).body;
    expect(page.items.map((l: { id: string }) => l.id)).toEqual([a.licenseId]);
    const valid = schemaValidator('License');
    expect(valid(page.items[0]) ? [] : valid.errors).toEqual([]);
    expect(page.items[0]).toMatchObject({ order_id: a.orderId, listing_id: a.listingId, organization_id: a.orgId, status: 'active', delivery_ready: true, price: { amount_minor: 10_000, currency: 'USD' } });
    expect(Object.keys(page.items[0])).not.toContain('material_id');
    await http().get(`/v1/licenses/${other.licenseId}`).set(as(member.token)).expect(404);
    // organization_id يُتجاهل للمشتري
    expect((await http().get(`/v1/licenses?organization_id=${other.orgId}`).set(as(member.token)).expect(200)).body.items.map((l: { id: string }) => l.id)).toEqual([a.licenseId]);
    const staff = (await http().get(`/v1/licenses?organization_id=${other.orgId}`).set(as(finance.token)).expect(200)).body.items;
    expect(staff.map((l: { id: string }) => l.id)).toEqual([other.licenseId]);
    await http().get(`/v1/licenses/${a.licenseId}`).set(as(rights.token)).expect(200);
  });

  it('download-url: a short-lived signed link per grant, counted to the limit, never stored, and only for the own active license', async () => {
    const a = await licensed();
    const first = await download(a.buyer.token, a.licenseId).expect(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const valid = schemaValidator('LicenseDownloadUrl');
    expect(valid(first.body) ? [] : valid.errors).toEqual([]);
    expect(first.body).toMatchObject({ url: expect.stringContaining('X-Amz-Expires=600'), downloads_remaining: 1 });
    const ttl = Date.parse(first.body.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);

    // الرابط لا يُحفظ: لا في جدول منع التكرار ولا في سجل المنح ولا في التدقيق
    const key = randomUUID();
    await download(a.buyer.token, a.licenseId, key).expect(200);
    const replay = await download(a.buyer.token, a.licenseId, key).expect(200);
    expect(replay.body).not.toHaveProperty('url');
    const { rows: stored } = await h.pool.query(`SELECT response_body::text AS b FROM idempotency_keys WHERE response_body::text LIKE '%storage.test%'`);
    expect(stored).toEqual([]);
    const { rows: grants } = await h.pool.query(`SELECT to_jsonb(g)::text AS g FROM license_download_grants g WHERE license_id = $1`, [a.licenseId]);
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.g).join()).not.toContain('storage.test');

    expect((await download(a.buyer.token, a.licenseId).expect(409)).body.code).toBe('download_limit_reached');
    const other = await licensed();
    await download(other.buyer.token, a.licenseId).expect(404);
    await download(finance.token, a.licenseId).expect(403);
  });

  it('download-url refuses a revoked license, a package not built yet, and a suspended organization', async () => {
    const pending = await licensed(false);
    expect((await download(pending.buyer.token, pending.licenseId).expect(409)).body.code).toBe('delivery_not_ready');
    expect((await http().get(`/v1/licenses/${pending.licenseId}`).set(as(pending.buyer.token)).expect(200)).body.delivery_ready).toBe(false);

    const revoked = await licensed();
    await h.pool.query(`UPDATE licenses SET status = 'revoked', revoked_reason = 'manual' WHERE id = $1`, [revoked.licenseId]);
    expect((await download(revoked.buyer.token, revoked.licenseId).expect(409)).body.code).toBe('license_not_active');

    const suspended = await licensed();
    await h.pool.query(`UPDATE buyer_organizations SET status = 'suspended' WHERE id = $1`, [suspended.orgId]);
    expect((await download(suspended.buyer.token, suspended.licenseId).expect(403)).body.code).toBe('forbidden_scope');
  });

  it('the sandbox page returns the buyer to the configured web page only, with the outcome as a hint', async () => {
    const t = await template();
    const { listingId } = await listed([t]);
    const b = await buyer(await organization());
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    const { ref: r } = await ref(b.token, created.id);
    expect((await http().get(`/sandbox/checkout/${r}`).expect(200)).text).toContain(`${r}/succeeded?return=1`);
    const back = await http().post(`/sandbox/checkout/${r}/succeeded?return=1`).expect(303);
    expect(back.headers.location).toBe(`https://web.example/ar/orders/${created.id}?outcome=succeeded`);
    // بلا return=1 (نداء آلي) 202 كما كان، ولا شيء من الطلب يغيّر الوجهة
    await http().post(`/sandbox/checkout/${r}/failed?return=https://evil.example`).expect(202);
    expect((await order(b.token, created.id)).status).toBe('paid');
  });

  // صفحة التحقق العامة (#406): بلا مصادقة ولا كوكي، وثلاثة حقول وحدها، وحد معدل لكل عنوان
  it('the public verification answers only the number, the status and the end, with no cookie, and is rate-limited', async () => {
    const a = await licensed(false);
    const number = (await http().get(`/v1/licenses/${a.licenseId}`).set(as(finance.token)).expect(200)).body.license_number as string;
    const res = await http().get(`/v1/license-verifications/${number}`).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/اسم عمل اصطناعي خاص|work_name|sha256|fingerprint/);
    expect(Object.keys(res.body).sort()).toEqual(['license_number', 'status', 'valid_until']);
    expect(res.body).toMatchObject({ license_number: number, status: 'active' });
    const valid = schemaValidator('LicenseVerification');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    for (const id of [a.licenseId, a.orgId, a.orderId, a.listingId, a.buyer.id]) expect(res.text).not.toContain(id);
    // المجهول وغير الصالح 404 واحد
    expect((await http().get('/v1/license-verifications/PH-2026-0000000000').expect(404)).body.code).toBe('not_found');
    await http().get('/v1/license-verifications/not-a-number').expect(404);
    // الحد 6 لكل عنوان في النافذة: ثلاثة بعد ما سبق، ثم 429 بـ Retry-After
    for (let i = 0; i < 3; i++) await http().get(`/v1/license-verifications/${number}`).expect(200);
    const limited = await http().get(`/v1/license-verifications/${number}`).expect(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
