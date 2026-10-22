import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// قوالب التراخيص (v0.3، ADR 0025): إصدارات لا تُعدَّل، والاستبدال إصدار يليه، والنوع ثابت، وبالعربية والإنجليزية
describe('license templates (/v1/license-templates)', () => {
  let h: Harness;
  let rights: Actor;
  let admin: Actor;
  let chief: Actor;
  let finance: Actor;
  let producer: Actor;
  beforeAll(async () => {
    h = await createHarness();
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const get = (a: Actor, url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`);
  const post = (a: Actor, body: object) =>
    http().post('/v1/license-templates').set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const put = (a: Actor, id: string, body: object, ifMatch?: string) => {
    const r = http().put(`/v1/license-templates/${id}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID());
    return (ifMatch ? r.set('If-Match', ifMatch) : r).send(body);
  };
  const template = (over: Record<string, unknown> = {}) => ({
    type: 'editorial_single',
    name: { ar: 'تحريري لمرة واحدة', en: 'Editorial single use' },
    terms: { ar: 'شروط', en: 'Terms' },
    usage_media: ['tv', 'web'],
    territory: { kind: 'worldwide' },
    term_days: null,
    exclusivity_hours: null,
    deliverables: ['original', 'produced'],
    attribution: { ar: 'المصدر: الشبكة', en: 'Source: the network' },
    prohibitions: ['resale', 'ai_training'],
    base_price: { amount_minor: 15000, currency: 'USD' },
    enabled: true,
    ...over,
  });
  // المخطط LicenseTemplate في العقد allOf على LicenseTemplateInput المغلق (additionalProperties: false) فلا يقبل id ولا
  // version؛ يُتحقق من الجزء المدخل بمخططه، ومن الحقول المضافة باختبارها، إلى أن يُصحَّح العقد
  const inputSchema = schemaValidator('LicenseTemplateInput');
  const valid = (body: Record<string, unknown>) => {
    const { id: _i, version: _v, created_at: _c, created_by: _b, ...input } = body;
    return inputSchema(input);
  };

  it('creates version 1 with its ETag, in the contract shape, audited by id only', async () => {
    const res = await post(rights, template()).expect(201);
    expect(valid(res.body) ? [] : inputSchema.errors).toEqual([]);
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(['id', 'version', 'created_at', 'created_by']));
    expect(res.headers.etag).toBe('"1"');
    expect(res.body).toMatchObject({ version: 1, created_by: rights.id, type: 'editorial_single', base_price: { amount_minor: 15000, currency: 'USD' } });
    const { rows } = await h.pool.query(`SELECT action, details FROM audit_log WHERE target_id = $1`, [res.body.id]);
    expect(rows).toEqual([{ action: 'license_template.created', details: { license_template_id: res.body.id, license_version: 1 } }]);
  });

  it('replacing writes the next version and keeps the previous one readable as it was; a stale If-Match is 412; the type is fixed', async () => {
    const id = (await post(admin, template({ type: 'editorial_term', term_days: 30 })).expect(201)).body.id as string;
    const v2 = await put(rights, id, template({ type: 'editorial_term', term_days: 90, base_price: { amount_minor: 30000, currency: 'ILS' } }), '"1"').expect(200);
    expect(v2.headers.etag).toBe('"2"');
    expect(v2.body).toMatchObject({ id, version: 2, term_days: 90, base_price: { amount_minor: 30000, currency: 'ILS' } });
    const v1 = await get(chief, `/license-templates/${id}?version=1`).expect(200);
    expect(v1.headers.etag).toBe('"1"');
    expect(v1.body).toMatchObject({ version: 1, term_days: 30, base_price: { amount_minor: 15000, currency: 'USD' } });
    expect((await get(finance, `/license-templates/${id}`).expect(200)).body.version).toBe(2);
    expect((await put(rights, id, template({ type: 'editorial_term', term_days: 7 }), '"1"').expect(412)).body.code).toBe('precondition_failed');
    const typed = await put(rights, id, template({ type: 'editorial_single' }), '"2"').expect(422);
    expect(JSON.stringify(typed.body)).toContain('/type');
    await get(chief, `/license-templates/${id}?version=3`).expect(404);
    const { rows } = await h.pool.query(`SELECT action, details->>'license_version' AS v FROM audit_log WHERE target_id = $1 ORDER BY id`, [id]);
    expect(rows.map((r) => [r.action, r.v])).toEqual([
      ['license_template.created', '1'],
      ['license_template.version_created', '2'],
    ]);
  });

  it('a stored version cannot be changed or deleted, even directly in the database', async () => {
    const id = (await post(rights, template()).expect(201)).body.id as string;
    await expect(h.pool.query(`UPDATE license_template_versions SET base_price_minor = 1 WHERE template_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`DELETE FROM license_template_versions WHERE template_id = $1`, [id])).rejects.toThrow(/immutable/);
  });

  it('refuses with 422: a transcript deliverable (R11), countries with worldwide or missing, a term or exclusivity that does not fit the type, one language only', async () => {
    const field = async (body: object, path: string) => {
      const res = await post(rights, body).expect(422);
      expect(res.body.code).toBe('validation_failed');
      expect([path, JSON.stringify(res.body).includes(path)]).toEqual([path, true]);
    };
    await post(rights, template({ deliverables: ['original', 'transcript'] })).expect(422);
    await post(rights, template({ type: 'subscription' })).expect(422);
    await field(template({ territory: { kind: 'worldwide', countries: ['PS'] } }), '/territory/countries');
    await field(template({ territory: { kind: 'countries' } }), '/territory/countries');
    await field(template({ type: 'editorial_term', term_days: null }), '/term_days');
    await field(template({ type: 'exclusive_temporary', term_days: 30, exclusivity_hours: null }), '/exclusivity_hours');
    await field(template({ exclusivity_hours: 48 }), '/exclusivity_hours');
    await post(rights, template({ name: { ar: 'فقط' } })).expect(422);
    await post(rights, template({ type: 'exclusive_temporary', term_days: 30, exclusivity_hours: 48, territory: { kind: 'countries', countries: ['PS', 'JO'] } })).expect(201);
  });

  it('lists the current version of each template; disabled ones only with include_disabled', async () => {
    const id = (await post(rights, template()).expect(201)).body.id as string;
    await put(rights, id, template({ enabled: false }), '"1"').expect(200);
    const listed = (await get(finance, '/license-templates').expect(200)).body.items as Array<{ id: string; version: number }>;
    expect(listed.map((t) => t.id)).not.toContain(id);
    const all = (await get(finance, '/license-templates?include_disabled=true').expect(200)).body.items as Array<{ id: string; version: number; enabled: boolean }>;
    expect(all.find((t) => t.id === id)).toMatchObject({ version: 2, enabled: false });
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  it('reads are for admin, rights, editor in chief and finance; writes for admin and rights only', async () => {
    const id = (await post(rights, template()).expect(201)).body.id as string;
    for (const a of [chief, finance]) {
      await post(a, template()).expect(403);
      await put(a, id, template(), '"1"').expect(403);
    }
    await get(producer, '/license-templates').expect(403);
    await get(producer, `/license-templates/${id}`).expect(403);
    await get(rights, `/license-templates/${randomUUID()}`).expect(404);
    await get(rights, '/license-templates/not-a-uuid').expect(404);
  });
});
