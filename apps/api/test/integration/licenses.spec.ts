import { hash } from '@node-rs/argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { Readable } from 'node:stream';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { createHarness, drainOutbox, type Harness, loginAs, makeSaleable, seedUploadSession, seedUser, statementsDuring } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;
const SECRET = randomBytes(32).toString('hex');
const WORKER = randomBytes(32).toString('base64url');

class SigningStorage implements ObjectStorage {
  // مشتقات عامل الوسائط في حاوية media وحدها؛ ما ليس هنا غير موجود
  sizes = new Map<string, number>();
  async head(bucket: string, key: string) {
    const size = bucket === 'media' ? this.sizes.get(key) : undefined;
    return size === undefined ? null : { size };
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
  const storage = new SigningStorage();
  beforeAll(async () => {
    h = await createHarness({
      env: {
        PAYMENT_PROVIDER: 'sandbox',
        SANDBOX_WEBHOOK_SECRET: SECRET,
        SANDBOX_CHECKOUT_BASE_URL: 'http://api.test',
        SANDBOX_RETURN_URL: 'https://web.example/{locale}/store/orders/{order_id}?returned=1',
        LICENSE_DOWNLOAD_LIMIT: '2',
        LICENSE_DOWNLOAD_URL_SECONDS: '600',
        LICENSE_VERIFY_RATE_LIMIT_MAX: '6',
        MEDIA_WORKER_TOKEN: WORKER,
      },
      overrides: [[OBJECT_STORAGE, storage]],
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
    await makeSaleable(h, materialId);
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

  it('lists a page of licenses in a fixed number of statements, each item equal to its own read', async () => {
    const t = await template();
    const b = await buyer(await organization());
    const listings = [await listed([t]), await listed([t]), await listed([t])];
    const created = (await post(b.token, '/orders', { items: listings.map((l) => ({ listing_id: l.listingId, license_template_id: t })) }).expect(201)).body;
    await pay((await ref(b.token, created.id)).ref);
    // حزمة التسليم جاهزة لترخيص واحد من الثلاثة
    const first = (await order(b.token, created.id)).items.find((i: { listing_id: string }) => i.listing_id === listings[0]!.listingId);
    const { rows } = await h.pool.query<{ id: string }>(`SELECT id FROM material_files WHERE material_id = $1 AND kind = 'original'`, [listings[0]!.materialId]);
    await h.pool.query(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at, derived_from_id, license_id)
       VALUES ($1, 'delivery', 'verified', 100, $2, $3, now(), $4, $5)`,
      [listings[0]!.materialId, randomBytes(32), `delivery/${first.license_id}/package.zip`, rows[0]!.id, first.license_id],
    );
    const list = (limit: number) => http().get(`/v1/licenses?limit=${limit}`).set(as(b.token)).expect(200);
    const page = (await list(3)).body;
    expect(page.items).toHaveLength(3);
    for (const item of page.items) expect(item).toEqual((await http().get(`/v1/licenses/${item.id}`).set(as(b.token)).expect(200)).body);
    expect(page.items.filter((l: { delivery_ready: boolean }) => l.delivery_ready).map((l: { id: string }) => l.id)).toEqual([first.license_id]);
    // صفحة من ثلاثة لا تزيد جملة واحدة على صفحة من واحد
    expect(await statementsDuring(h, () => list(3))).toBe(await statementsDuring(h, () => list(1)));
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

  // الحلقة كما يمشيها عامل الوسائط (#252، ADR 0025 الجزء 9): حزمة التسليم تُسجَّل عبر النقطة الداخلية بـ license_id، فتجهز
  // صفحة الترخيص ويعمل رابط التنزيل؛ لا إدراج بـ SQL هنا (كان الإدراج بلا license_id يكسر القيد فتبقى الصفحة «قيد التجهيز»)
  it('the media worker registers the delivery package through /internal/media for its license only, idempotently', async () => {
    const a = await licensed(false);
    const { rows } = await h.pool.query<{ id: string; material_id: string }>(
      `SELECT f.id, f.material_id FROM material_files f JOIN licenses l ON l.material_id = f.material_id WHERE l.id = $1 AND f.kind = 'original'`,
      [a.licenseId],
    );
    const source = rows[0]!;
    const derive = (fileId: string, body: object) =>
      http().post(`/internal/media/files/${fileId}/derivatives`).set('Authorization', `Bearer ${WORKER}`).send(body);
    const pkg = (licenseId: string, sha = randomBytes(32).toString('hex')) => {
      const key = `derived/${source.material_id}/${source.id}/delivery/${licenseId}.zip`;
      storage.sizes.set(key, 4096);
      return { kind: 'delivery', license_id: licenseId, storage_key: key, sha256: sha, size_bytes: 4096, mime_type: 'application/zip', technical: { duration_ms: 1000, start_pts_us: 0 } };
    };
    const body = pkg(a.licenseId);
    const first = await derive(source.id, body).expect(200);
    expect((await derive(source.id, body).expect(200)).body.file_id).toBe(first.body.file_id);
    const [file] = (await h.pool.query(`SELECT kind, license_id, derived_from_id, state FROM material_files WHERE id = $1`, [first.body.file_id])).rows;
    expect(file).toEqual({ kind: 'delivery', license_id: a.licenseId, derived_from_id: source.id, state: 'verified' });
    expect((await http().get(`/v1/licenses/${a.licenseId}`).set(as(a.buyer.token)).expect(200)).body.delivery_ready).toBe(true);
    await download(a.buyer.token, a.licenseId).expect(200);
    // حزمة مختلفة للترخيص نفسه 409، وبلا license_id 422
    expect((await derive(source.id, { ...body, sha256: randomBytes(32).toString('hex') }).expect(409)).body.code).toBe('upload_state_conflict');
    const { license_id: _omit, ...unlicensed } = body;
    await derive(source.id, unlicensed).expect(422);
    // ترخيص مادة أخرى، أو ترخيص مجهول: 422 على /license_id ولا صف
    const other = await licensed(false);
    for (const licenseId of [other.licenseId, randomUUID()]) {
      const res = await derive(source.id, pkg(licenseId)).expect(422);
      expect(res.body.details).toEqual({ fields: ['/license_id'] });
    }
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM material_files WHERE kind = 'delivery' AND license_id = ANY($1)`, [[other.licenseId]])).rows[0].n).toBe(0);
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

  // ADR 0118: خروج الحقوق من sellable ووسم الحساسية كانا يتركان الترخيص فاعلًا ورابط التنزيل 200
  it('rights leaving sellable revoke the material licenses as rights_withdrawn in the same transition, notify the buyer by license number, and stop downloads', async () => {
    const a = await licensed();
    const colleague = await buyer(a.orgId, 'buyer_member');
    const materialId = (await h.pool.query<{ material_id: string }>(`SELECT material_id FROM licenses WHERE id = $1`, [a.licenseId])).rows[0]!.material_id;
    await download(a.buyer.token, a.licenseId).expect(200);
    await post(rights.token, `/materials/${materialId}/transitions`, { track: 'rights', to: 'withdrawn', reason: 'contract ended' }).expect(200);
    const license = (await http().get(`/v1/licenses/${a.licenseId}`).set(as(a.buyer.token)).expect(200)).body;
    expect(license).toMatchObject({ status: 'revoked', revoked_reason: 'rights_withdrawn' });
    expect((await download(a.buyer.token, a.licenseId).expect(409)).body.code).toBe('license_not_active');
    const { rows: events } = await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'license.revoked' AND aggregate_id = $1`, [a.licenseId]);
    expect(events).toEqual([{ payload: { license_id: a.licenseId, organization_id: a.orgId, material_id: materialId, revoked_reason: 'rights_withdrawn' } }]);
    await drainOutbox(h);
    for (const member of [a.buyer, colleague]) {
      const inbox = (await http().get('/v1/notifications?limit=100').set(as(member.token)).expect(200)).body.items as Array<{ type: string; title: string; material_id: string | null }>;
      const alert = inbox.filter((n) => n.type === 'license.revoked');
      expect(alert).toHaveLength(1);
      expect(alert[0]!.title).toContain(license.license_number);
      expect(alert[0]!.material_id).toBeNull();
    }
  });

  it('tagging the material sensitive revokes its licenses too; a license still active on a material that is no longer sellable gets no link', async () => {
    const a = await licensed();
    const materialId = (await h.pool.query<{ material_id: string }>(`SELECT material_id FROM licenses WHERE id = $1`, [a.licenseId])).rows[0]!.material_id;
    const editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    await http()
      .patch(`/v1/materials/${materialId}`)
      .set(as(editor.token))
      .set('Idempotency-Key', randomUUID())
      .send({ sensitivity: { minors: false, injured: true, graphic: false } })
      .expect(200);
    expect((await http().get(`/v1/licenses/${a.licenseId}`).set(as(a.buyer.token)).expect(200)).body).toMatchObject({ status: 'revoked', revoked_reason: 'rights_withdrawn' });

    // ترخيص فاعل من قبل الإصلاح على مادة لم تعد قابلة للبيع: لا رابط وإن لم يُبطَل
    const b = await licensed();
    const other = (await h.pool.query<{ material_id: string }>(`SELECT material_id FROM licenses WHERE id = $1`, [b.licenseId])).rows[0]!.material_id;
    await download(b.buyer.token, b.licenseId).expect(200);
    await h.pool.query(`UPDATE catalog_listings SET state = 'suspended', suspended_reason = 'manual' WHERE material_id = $1`, [other]);
    await h.pool.query(`UPDATE materials SET rights_state = 'blocked' WHERE id = $1`, [other]);
    expect((await http().get(`/v1/licenses/${b.licenseId}`).set(as(b.buyer.token)).expect(200)).body.status).toBe('active');
    expect((await download(b.buyer.token, b.licenseId).expect(409)).body.code).toBe('license_not_active');
    await h.pool.query(`UPDATE materials SET rights_state = 'sellable', sensitivity_graphic = true WHERE id = $1`, [other]);
    expect((await download(b.buyer.token, b.licenseId).expect(409)).body.code).toBe('license_not_active');
  });

  it('a payment confirmed after the listed version lost editorial approval cancels the order (rights_changed) and issues no license', async () => {
    const t = await template();
    const { listingId, materialId } = await listed([t]);
    const b = await buyer(await organization());
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    const { ref: r } = await ref(b.token, created.id);
    const editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    await http().patch(`/v1/materials/${materialId}`).set(as(editor.token)).set('Idempotency-Key', randomUUID()).send({ title: 'Edited after approval' }).expect(200);
    const listing = (await http().get(`/v1/materials/${materialId}/listing`).set(as(rights.token)).expect(200)).body;
    expect(listing).toMatchObject({ state: 'suspended', suspended_reason: 'editorial_changed', material_version: 1 });
    await pay(r);
    expect(await order(b.token, created.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'rights_changed' });
    expect(await count(`SELECT count(*)::int AS n FROM licenses WHERE material_id = $1`, [materialId])).toBe(0);
  });

  it('CatalogItem.shot_list is empty for buyer roles at the API, and kept for staff', async () => {
    const t = await template();
    const { listingId } = await listed([t]);
    await h.pool.query(`UPDATE catalog_listings SET shot_list = $2 WHERE id = $1`, [listingId, JSON.stringify([{ start_ms: 0, label: { ar: 'لقطة', en: 'Shot' } }])]);
    const b = await buyer(await organization(), 'buyer_member');
    expect((await http().get(`/v1/catalog/${listingId}`).set(as(b.token)).expect(200)).body.shot_list).toEqual([]);
    const page = (await http().get('/v1/catalog?limit=100').set(as(b.token)).expect(200)).body.items as Array<{ listing_id: string; shot_list: unknown[] }>;
    expect(page.find((i) => i.listing_id === listingId)?.shot_list).toEqual([]);
    expect((await http().get(`/v1/catalog/${listingId}`).set(as(finance.token)).expect(200)).body.shot_list).toHaveLength(1);
  });

  // صفحة المزوّد التجريبي بلغة المشتري (ADR 0032، ملحق 2026-11-03): lang وdir، ونص التجربة الثابت في المتجر، وأزرار بأسمائها،
  // والعودة إلى /{locale}/store/orders/{order_id} من قالب الإعداد وحده، و{locale} من قائمة مغلقة
  it('the sandbox page speaks the checkout locale and returns the buyer to the configured web page only, in that locale', async () => {
    const t = await template();
    const { listingId } = await listed([t]);
    const b = await buyer(await organization());
    const created = (await post(b.token, '/orders', { items: [{ listing_id: listingId, license_template_id: t }] }).expect(201)).body;
    // بلا لغة: العربية
    const { ref: r } = await ref(b.token, created.id);
    const ar = (await http().get(`/sandbox/checkout/${r}`).expect(200)).text;
    expect(ar).toContain('<html lang="ar" dir="rtl">');
    expect(ar).toContain('بيئة دفع تجريبية: لا يُخصم مال حقيقي.');
    expect(ar).toContain(`${r}/succeeded?return=1`);
    expect(ar).toContain('>نجح الدفع<');
    expect(ar).not.toMatch(/<button[^>]*>(succeeded|failed|delayed|duplicate|out_of_order)</);
    // العودة دون دفع إلى الطلب نفسه، بلا علامة الرجوع من المزوّد
    expect(ar).toContain(`href="https://web.example/ar/store/orders/${created.id}"`);
    // الجلسة نفسها بلغة آخر طلب
    const en = (await post(b.token, `/orders/${created.id}/checkout`, { locale: 'en' }).expect(200)).body;
    expect((en.checkout_url as string).split('/').pop()).toBe(r);
    const page = (await http().get(`/sandbox/checkout/${r}`).expect(200)).text;
    expect(page).toContain('<html lang="en" dir="ltr">');
    expect(page).toContain('Test payment environment: no real money is charged.');
    expect(page).toContain('>Payment succeeds<');
    expect(page).toContain(`href="https://web.example/en/store/orders/${created.id}"`);
    // لغة خارج القائمة أو مفتاح آخر 422
    expect((await post(b.token, `/orders/${created.id}/checkout`, { locale: 'fr' }).expect(422)).body.details).toEqual({ fields: ['/locale'] });
    await post(b.token, `/orders/${created.id}/checkout`, { return_url: 'https://evil.example' }).expect(422);
    const back = await http().post(`/sandbox/checkout/${r}/succeeded?return=1`).expect(303);
    expect(back.headers.location).toBe(`https://web.example/en/store/orders/${created.id}?returned=1&outcome=succeeded`);
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
