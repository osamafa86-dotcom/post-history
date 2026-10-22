import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// إدراج المادة في الكتالوج (v0.3، ADR 0025): واحد لكل مادة، و`listed` يلزمه حقوق sellable، والإذن التجاري للإدارة وحدها
describe('material listing (/v1/materials/{id}/listing)', () => {
  let h: Harness;
  let rights: Actor;
  let admin: Actor;
  let finance: Actor;
  let producer: Actor;
  let reporterId: string;
  let editorial: string;
  let commercial: string;
  let disabled: string;
  beforeAll(async () => {
    h = await createHarness();
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    reporterId = (await seedUser(h)).id;
    const tpl = async (type: string, enabled = true) =>
      (
        await write(admin, 'post', '/license-templates', {
          type,
          name: { ar: 'ق', en: 'T' },
          terms: { ar: 'ش', en: 'Terms' },
          usage_media: ['web'],
          territory: { kind: 'worldwide' },
          term_days: null,
          exclusivity_hours: null,
          deliverables: ['original'],
          attribution: { ar: 'ن', en: 'A' },
          prohibitions: [],
          base_price: { amount_minor: 1000, currency: 'USD' },
          enabled,
        }).expect(201)
      ).body.id as string;
    editorial = await tpl('editorial_single');
    commercial = await tpl('commercial');
    disabled = await tpl('editorial_single', false);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  function write(a: Actor, method: 'post' | 'put', url: string, body: object, ifMatch?: string) {
    const r = http()[method](`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID());
    return (ifMatch ? r.set('If-Match', ifMatch) : r).send(body);
  }
  const get = (a: Actor, url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`);
  const listing = (over: Record<string, unknown> = {}) => ({
    title: { ar: 'عنوان', en: 'Title' },
    description: { ar: 'وصف', en: 'Description' },
    shot_list: [{ start_ms: 0, label: { ar: 'لقطة', en: 'Shot' } }],
    offers: [{ license_template_id: editorial, price_override: null }],
    state: 'draft',
    ...over,
  });
  const material = async () => (await seedUploadSession(h, reporterId)).materialId;
  const rightsTo = async (id: string, ...states: string[]) => {
    for (const to of states) await write(rights, 'post', `/materials/${id}/transitions`, { track: 'rights', to, reason: 'listing test' }).expect(200);
  };
  const states = async (id: string) =>
    (await h.pool.query(`SELECT editorial_state, technical_state, rights_state FROM materials WHERE id = $1`, [id])).rows[0];
  const events = async (listingId: string) =>
    (await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'catalog.listing_changed' AND aggregate_id = $1 ORDER BY id`, [listingId])).rows.map((r) => r.payload);
  const verifiedOriginal = async (materialId: string) => {
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key) VALUES ($1, 'original', 'received', 5000, $2, $3) RETURNING id`,
      [materialId, randomBytes(32), `tus/${randomUUID()}`],
    );
    await h.pool.query(`UPDATE material_files SET state = 'verified', verified_at = now() WHERE id = $1`, [rows[0]!.id]);
    return rows[0]!.id;
  };

  it('creates one draft listing per material, pinned to its version, with an ETag, an audit row and a listing event; the material states do not move', async () => {
    const id = await material();
    const before = await states(id);
    const fileId = await verifiedOriginal(id);
    const res = await write(rights, 'post', `/materials/${id}/listing`, listing()).expect(201);
    expect(res.headers.etag).toMatch(/^"\d+"$/);
    expect(res.body).toMatchObject({ material_id: id, material_version: 1, state: 'draft', suspended_reason: null, listed_at: null, commercial_allowed: false, updated_by: rights.id });
    expect(res.body.offers).toEqual([{ license_template_id: editorial, price_override: null }]);
    expect(await states(id)).toEqual(before);
    expect(await events(res.body.id)).toEqual([
      { listing_id: res.body.id, material_id: id, material_version: 1, source_file_id: fileId, state: 'draft', suspended_reason: null },
    ]);
    const { rows } = await h.pool.query(`SELECT action, details FROM audit_log WHERE target_id = $1`, [res.body.id]);
    expect(rows).toEqual([{ action: 'catalog_listing.created', details: { listing_id: res.body.id, material_id: id } }]);
    const read = await get(finance, `/materials/${id}/listing`).expect(200);
    expect(read.body).toEqual(res.body);
    expect(read.headers.etag).toBe(res.headers.etag);
    expect((await write(rights, 'post', `/materials/${id}/listing`, listing()).expect(409)).body.code).toBe('listing_exists');
  });

  it('listed needs sellable rights (409 rights_not_sellable); a stale If-Match is 412; listed_at is set once', async () => {
    const id = await material();
    const created = await write(rights, 'post', `/materials/${id}/listing`, listing()).expect(201);
    expect((await write(rights, 'put', `/materials/${id}/listing`, listing({ state: 'listed' }), created.headers.etag).expect(409)).body.code).toBe('rights_not_sellable');
    await rightsTo(id, 'documented', 'sellable');
    const listed = await write(rights, 'put', `/materials/${id}/listing`, listing({ state: 'listed' }), created.headers.etag).expect(200);
    expect(listed.body).toMatchObject({ state: 'listed', suspended_reason: null });
    expect(listed.body.listed_at).not.toBeNull();
    expect((await write(rights, 'put', `/materials/${id}/listing`, listing({ state: 'listed' }), created.headers.etag).expect(412)).body.code).toBe('precondition_failed');
    const paused = await write(rights, 'put', `/materials/${id}/listing`, listing({ state: 'suspended' }), listed.headers.etag).expect(200);
    expect(paused.body).toMatchObject({ state: 'suspended', suspended_reason: 'manual', listed_at: listed.body.listed_at });
    expect((await events(created.body.id)).map((e) => [e.state, e.suspended_reason])).toEqual([
      ['draft', null],
      ['listed', null],
      ['suspended', 'manual'],
    ]);
  });

  it('when rights leave sellable the listing is suspended for rights_changed in the same transition, and stays so until listed again on sellable rights', async () => {
    const id = await material();
    await rightsTo(id, 'documented', 'sellable');
    const created = await write(rights, 'post', `/materials/${id}/listing`, listing({ state: 'listed' })).expect(201);
    await rightsTo(id, 'blocked');
    const after = (await get(rights, `/materials/${id}/listing`).expect(200)).body;
    expect(after).toMatchObject({ state: 'suspended', suspended_reason: 'rights_changed' });
    expect((await events(created.body.id)).map((e) => [e.state, e.suspended_reason])).toEqual([
      ['listed', null],
      ['suspended', 'rights_changed'],
    ]);
    // تعديل الإدراج المعلّق دون إعادته يبقي سببه
    const kept = await write(rights, 'put', `/materials/${id}/listing`, listing({ state: 'suspended', title: { ar: 'جديد', en: 'New' } })).expect(200);
    expect(kept.body.suspended_reason).toBe('rights_changed');
    expect((await write(rights, 'put', `/materials/${id}/listing`, listing({ state: 'listed' })).expect(409)).body.code).toBe('rights_not_sellable');
  });

  it('commercial permission and commercial offers are for the system admin only; a rights officer edits around them', async () => {
    const id = await material();
    expect((await write(rights, 'post', `/materials/${id}/listing`, listing({ commercial_allowed: true })).expect(403)).body.code).toBe('forbidden_role');
    const both = { commercial_allowed: true, offers: [{ license_template_id: editorial }, { license_template_id: commercial, price_override: { amount_minor: 99900, currency: 'ILS' } }] };
    await write(admin, 'post', `/materials/${id}/listing`, listing({ offers: both.offers })).expect(422);
    const created = await write(admin, 'post', `/materials/${id}/listing`, listing(both)).expect(201);
    expect(created.body.commercial_allowed).toBe(true);
    await write(rights, 'put', `/materials/${id}/listing`, listing({ ...both, title: { ar: 'ت', en: 'T2' } })).expect(200);
    await write(rights, 'put', `/materials/${id}/listing`, listing({ commercial_allowed: false })).expect(403);
    await write(rights, 'put', `/materials/${id}/listing`, listing({ commercial_allowed: true })).expect(403);
    const revoked = await write(admin, 'put', `/materials/${id}/listing`, listing()).expect(200);
    expect(revoked.body).toMatchObject({ commercial_allowed: false, offers: [{ license_template_id: editorial, price_override: null }] });
  });

  it('offers: a template at most once, existing and enabled (422 on /offers); roles as in the contract; unknown material 404', async () => {
    const id = await material();
    for (const offers of [
      [{ license_template_id: editorial }, { license_template_id: editorial }],
      [{ license_template_id: disabled }],
      [{ license_template_id: randomUUID() }],
    ]) {
      const res = await write(rights, 'post', `/materials/${id}/listing`, listing({ offers })).expect(422);
      expect(JSON.stringify(res.body)).toContain('/offers');
    }
    await write(finance, 'post', `/materials/${id}/listing`, listing()).expect(403);
    await get(producer, `/materials/${id}/listing`).expect(403);
    await get(finance, `/materials/${id}/listing`).expect(404);
    await write(rights, 'post', `/materials/${randomUUID()}/listing`, listing()).expect(404);
  });
});
