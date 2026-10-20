import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

/** التزامن المتفائل (عقد v0.1، ADR 0012): ETag = row_version، وIf-Match المتقادم 412 دون أثر. */
describe('optimistic concurrency on materials (ETag / If-Match / 412)', () => {
  let h: Harness;
  let office: string;
  let reporter: Actor;
  let supervisor: Actor;
  let rights: Actor;
  let producer: Actor;
  beforeAll(async () => {
    h = await createHarness();
    await ensureForm(h);
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const write = (a: Actor, method: 'post' | 'patch' | 'put', url: string, body?: object, headers: Record<string, string> = {}, key = randomUUID()) => {
    let r = http()[method](url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const get = (a: Actor, id: string) => http().get(`/v1/materials/${id}`).set('Authorization', `Bearer ${a.token}`);
  const create = async () =>
    (
      await write(reporter, 'post', '/v1/materials', {
        title: 'Concurrency',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority: 'normal',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      }).expect(201)
    ).body as { id: string; row_version: number };
  const events = async (id: string) => (await h.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [id])).rows[0].n as number;

  it('GET and writes carry ETag = "row_version"; every write raises it', async () => {
    const m = await create();
    const read = await get(reporter, m.id).expect(200);
    expect(read.body.row_version).toBeGreaterThanOrEqual(1);
    expect(read.headers.etag).toBe(`"${read.body.row_version}"`);
    const edited = await write(reporter, 'patch', `/v1/materials/${m.id}`, { title: 'Edited' }, { 'If-Match': read.headers.etag }).expect(200);
    expect(edited.body.row_version).toBeGreaterThan(read.body.row_version);
    expect(edited.headers.etag).toBe(`"${edited.body.row_version}"`);
    // بلا If-Match يعمل كما في v0
    await write(reporter, 'patch', `/v1/materials/${m.id}`, { title: 'No precondition' }).expect(200);
  });

  it('a stale or malformed If-Match is 412 precondition_failed with no effect', async () => {
    const m = await create();
    const stale = (await get(reporter, m.id).expect(200)).headers.etag as string;
    await write(supervisor, 'patch', `/v1/materials/${m.id}`, { title: 'Supervisor wins' }).expect(200);
    const before = (await get(reporter, m.id).expect(200)).body;
    const eventsBefore = await events(m.id);
    for (const ifMatch of [stale, '"999999"', 'W/"1"', '*', 'abc']) {
      const res = await write(reporter, 'patch', `/v1/materials/${m.id}`, { title: 'Reporter loses' }, { 'If-Match': ifMatch }).expect(412);
      expect(res.body.code).toBe('precondition_failed');
    }
    const after = (await get(reporter, m.id).expect(200)).body;
    expect(after).toMatchObject({ title: 'Supervisor wins', row_version: before.row_version });
    expect(await events(m.id)).toBe(eventsBefore);
  });

  it('transitions, contributors and reservation honour If-Match too', async () => {
    const m = await create();
    const etag = (await get(supervisor, m.id).expect(200)).headers.etag as string;
    const ack = { track: 'editorial', to: 'acknowledged', reason: 'seen' };
    await write(supervisor, 'post', `/v1/materials/${m.id}/transitions`, ack, { 'If-Match': '"999999"' }).expect(412);
    const moved = await write(supervisor, 'post', `/v1/materials/${m.id}/transitions`, ack, { 'If-Match': etag }).expect(200);
    expect(moved.headers.etag).toBe(`"${moved.body.row_version}"`);

    const contributors = { contributors: [{ user_id: reporter.id, role: 'reporter', share_percent: 100 }] };
    await write(rights, 'put', `/v1/materials/${m.id}/contributors`, contributors, { 'If-Match': etag }).expect(412);
    await write(rights, 'put', `/v1/materials/${m.id}/contributors`, contributors, { 'If-Match': moved.headers.etag }).expect(200);

    await h.pool.query(`UPDATE materials SET editorial_state = 'accepted' WHERE id = $1`, [m.id]);
    const current = (await get(producer, m.id).expect(200)).headers.etag as string;
    await write(producer, 'post', `/v1/materials/${m.id}/reservation`, undefined, { 'If-Match': etag }).expect(412);
    await write(producer, 'post', `/v1/materials/${m.id}/reservation`, undefined, { 'If-Match': current }).expect(200);
  });

  it('a replay of the same Idempotency-Key returns the same body and ETag, without re-checking If-Match', async () => {
    const m = await create();
    const etag = (await get(reporter, m.id).expect(200)).headers.etag as string;
    const key = randomUUID();
    const first = await write(reporter, 'patch', `/v1/materials/${m.id}`, { title: 'Once only' }, { 'If-Match': etag }, key).expect(200);
    const again = await write(reporter, 'patch', `/v1/materials/${m.id}`, { title: 'Once only' }, { 'If-Match': etag }, key).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(again.headers.etag).toBe(first.headers.etag);
  });
});
