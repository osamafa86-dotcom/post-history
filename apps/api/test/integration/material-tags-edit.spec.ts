import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// نص وسم كناري: لا يظهر في حدث ولا تدقيق ولا إشعار (ADR 0086، 0104)
const CANARY = 'وسم كناري';

// وسوم المادة من المكتب (W2، ADR 0104): صفة أرشفة لا ترفع version ولا تمس الحالات الثلاث
describe('material tags from the desk (PUT /v1/materials/{id}/tags)', () => {
  let h: Harness;
  let office: string;
  let reporter: Actor;
  let supervisor: Actor;
  let otherSupervisor: Actor;
  let chief: Actor;
  let producer: Actor;

  beforeAll(async () => {
    h = await createHarness();
    await ensureForm(h);
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    office = await newOffice();
    const otherOffice = await newOffice();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: otherOffice }, { role: 'producer' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const material = async (editorial = 'accepted') => {
    const res = await http()
      .post('/v1/materials')
      .set('Authorization', `Bearer ${reporter.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: 'عنوان تجريبي',
        material_types: ['report'],
        governorate: 'محافظة',
        city: 'مدينة',
        priority: 'normal',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
        tags: ['وسم أول'],
      })
      .expect(201);
    await h.pool.query(`UPDATE materials SET editorial_state = $2 WHERE id = $1`, [res.body.id, editorial]);
    return res.body.id as string;
  };
  const put = (a: Actor, id: string, tags: unknown, opts: { key?: string; ifMatch?: string } = {}) =>
    http()
      .put(`/v1/materials/${id}/tags`)
      .set('Authorization', `Bearer ${a.token}`)
      .set('Idempotency-Key', opts.key ?? randomUUID())
      .set(opts.ifMatch ? { 'If-Match': opts.ifMatch } : {})
      .send({ tags });
  const read = (a: Actor, id: string) => http().get(`/v1/materials/${id}`).set('Authorization', `Bearer ${a.token}`);

  it('replaces the tags with If-Match: row_version rises alone, version and the three states stay, no tag text leaves', async () => {
    const m = await material('accepted');
    const before = await read(supervisor, m).expect(200);
    const key = randomUUID();
    const res = await put(supervisor, m, [CANARY, 'وسم ثانٍ'], { key, ifMatch: before.headers.etag }).expect(200);
    expect(res.body.tags).toEqual([CANARY, 'وسم ثانٍ']);
    expect(res.body).toMatchObject({ version: before.body.version, editorial_state: 'accepted', technical_state: before.body.technical_state, rights_state: before.body.rights_state });
    expect(res.body.row_version).toBe(before.body.row_version + 1);
    expect(res.headers.etag).toBe(`"${res.body.row_version}"`);
    const valid = schemaValidator('Material');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    // التكرار بالمفتاح نفسه، والقائمة نفسها بمفتاح جديد، لا يكتبان شيئًا
    await put(supervisor, m, [CANARY, 'وسم ثانٍ'], { key, ifMatch: before.headers.etag }).expect(200);
    const same = await put(chief, m, [CANARY, 'وسم ثانٍ']).expect(200);
    expect(same.body.row_version).toBe(res.body.row_version);
    // ETag قديم 412 بلا أثر
    expect((await put(chief, m, ['وسم ثالث'], { ifMatch: before.headers.etag }).expect(412)).body.code).toBe('precondition_failed');
    // رئيس التحرير يمحوها بمصفوفة فارغة
    expect((await put(chief, m, [], { ifMatch: res.headers.etag }).expect(200)).body.tags).toEqual([]);

    const events = (await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 AND type = 'material.updated' ORDER BY id`, [m])).rows;
    expect(events).toHaveLength(2);
    expect(events[0].payload).toEqual({ material_id: m, priority: 'normal', office_id: office, material_version: before.body.version, editorial_state: 'accepted' });
    const audit = (await h.pool.query(`SELECT actor_id, details FROM audit_log WHERE action = 'material.tags_changed' AND target_id = $1 ORDER BY id`, [m])).rows;
    expect(audit).toEqual([
      { actor_id: supervisor.id, details: { material_id: m } },
      { actor_id: chief.id, details: { material_id: m } },
    ]);
    await drainOutbox(h);
    const leaked = await h.pool.query(
      `SELECT (SELECT count(*) FROM outbox_events WHERE payload::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM audit_log WHERE details::text LIKE '%' || $1 || '%')
            + (SELECT count(*) FROM notifications WHERE title LIKE '%' || $1 || '%') AS n`,
      [CANARY],
    );
    expect(Number(leaked.rows[0].n)).toBe(0);
  });

  it('is for a supervisor covering the material and the editor-in-chief only', async () => {
    const m = await material('inbox');
    expect((await put(otherSupervisor, m, ['وسم']).expect(404)).status).toBe(404);
    expect((await put(reporter, m, ['وسم']).expect(403)).body.code).toBe('forbidden_role');
    expect((await put(producer, m, ['وسم']).expect(403)).body.code).toBe('forbidden_role');
    // مشرف خارج النطاق يرى المادة المقبولة بدور الإنتاج، فيُرد 403 لا 404
    const accepted = await material('accepted');
    expect((await put(otherSupervisor, accepted, ['وسم']).expect(403)).body.code).toBe('forbidden_scope');
    await put(supervisor, m, ['وسم']).expect(200);
  });

  it('enforces the tag rule of ADR 0086 (422)', async () => {
    const m = await material('inbox');
    for (const tags of [[' وسم'], ['وسم '], ['وس\u200fم'], ['أ'.repeat(41)], ['وسم', 'وسم'], Array.from({ length: 13 }, (_, i) => `وسم ${i}`), ['']]) {
      expect((await put(supervisor, m, tags).expect(422)).body.code).toBe('validation_failed');
    }
    await http().put(`/v1/materials/${m}/tags`).set('Authorization', `Bearer ${supervisor.token}`).set('Idempotency-Key', randomUUID()).send({}).expect(422);
    expect((await read(supervisor, m).expect(200)).body.tags).toEqual(['وسم أول']);
  });
});
