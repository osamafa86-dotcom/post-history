import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, currentFormVersion, type Harness, loginAs } from './harness';

describe('forms (/v1/forms)', () => {
  let h: Harness;
  let admin: string;
  let reporter: string;
  beforeAll(async () => {
    h = await createHarness();
    admin = (await loginAs(h, [{ role: 'system_admin' }])).token;
    reporter = (await loginAs(h, [{ role: 'reporter' }])).token;
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const publish = (token: string, body: object) =>
    http().post('/v1/forms').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);

  const form = (version: number, fields: object[] = []) => ({
    version,
    fields: [
      { key: 'notes', type: 'long_text', label: { ar: 'ملاحظات', en: 'Notes' }, required: false },
      {
        key: 'guest_name',
        type: 'short_text',
        label: { ar: 'الضيف', en: 'Guest' },
        required: true,
        material_types: ['interview'],
      },
      ...fields,
    ],
  });

  it('If-Match names the current version: a stale one is 412 before the version check, the current one publishes', async () => {
    const current = await currentFormVersion(h);
    const withIfMatch = (ifMatch: string, body: object) =>
      http().post('/v1/forms').set('Authorization', `Bearer ${admin}`).set('Idempotency-Key', randomUUID()).set('If-Match', ifMatch).send(body);
    expect((await withIfMatch(`"${current + 7}"`, form(current + 1)).expect(412)).body.code).toBe('precondition_failed');
    expect(await currentFormVersion(h)).toBe(current);
    await withIfMatch(`"${current}"`, form(current + 1)).expect(201);
  });

  it('publishes version current+1, writes form.published, and serves it as current', async () => {
    const v = (await currentFormVersion(h)) + 1;
    const res = await publish(admin, form(v)).expect(201);
    expect(res.body).toMatchObject({ version: v, published_by: expect.any(String), published_at: expect.any(String) });
    const current = await http().get('/v1/forms/current').set('Authorization', `Bearer ${reporter}`).expect(200);
    expect(current.body.version).toBe(v);
    expect(current.body.fields.map((f: { key: string }) => f.key)).toEqual(['notes', 'guest_name']);
    const filtered = await http()
      .get('/v1/forms/current?material_type=report')
      .set('Authorization', `Bearer ${reporter}`)
      .expect(200);
    expect(filtered.body.version).toBe(v);
    expect(filtered.body.fields.map((f: { key: string }) => f.key)).toEqual(['notes']);
    const { rows } = await h.pool.query(`SELECT payload FROM outbox_events WHERE idempotency_key = $1`, [`form.published:${v}`]);
    expect(rows[0].payload).toEqual({ version: v });
  });

  it('rejects a stale or skipped version with 409 form_version_conflict', async () => {
    const v = await currentFormVersion(h);
    expect((await publish(admin, form(v)).expect(409)).body.code).toBe('form_version_conflict');
    await publish(admin, form(v + 2)).expect(409);
  });

  it('two concurrent publishes of the same version: one wins, the other gets 409', async () => {
    const v = (await currentFormVersion(h)) + 1;
    const results = await Promise.all([publish(admin, form(v)), publish(admin, form(v))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('v0 gate: sensitive or location fields are rejected with 422 sensitive_fields_not_supported_v0', async () => {
    const v = (await currentFormVersion(h)) + 1;
    const sensitive = { key: 'source', type: 'short_text', label: { ar: 'م', en: 's' }, required: false, sensitive: true };
    const location = { key: 'place', type: 'location', label: { ar: 'م', en: 'l' }, required: false };
    for (const f of [sensitive, location]) {
      expect((await publish(admin, form(v, [f])).expect(422)).body.code).toBe('sensitive_fields_not_supported_v0');
    }
  });

  it('validates the body against upload-form.json and checks keys and conditions', async () => {
    const v = (await currentFormVersion(h)) + 1;
    expect((await publish(admin, { version: v, fields: [{ key: 'Bad Key' }] }).expect(422)).body.code).toBe('validation_failed');
    const dup = { key: 'notes', type: 'short_text', label: { ar: 'م', en: 'n' }, required: false };
    expect((await publish(admin, form(v, [dup])).expect(422)).body.details.fields).toEqual(['/fields/2/key']);
    const badCond = {
      key: 'follow',
      type: 'short_text',
      label: { ar: 'م', en: 'f' },
      required: false,
      condition: { field: 'missing', equals: 'x' },
    };
    expect((await publish(admin, form(v, [badCond])).expect(422)).body.details.fields).toEqual(['/fields/2/condition/field']);
  });

  it('enforces roles: reporters cannot publish or list (403 before anything else)', async () => {
    expect((await publish(reporter, form(1)).expect(403)).body.code).toBe('forbidden_role');
    await http().get('/v1/forms').set('Authorization', `Bearer ${reporter}`).expect(403);
  });

  it('lists versions newest first with the current flag, and reads an old version as published', async () => {
    const res = await http().get('/v1/forms').set('Authorization', `Bearer ${admin}`).expect(200);
    const versions = res.body.items.map((i: { version: number }) => i.version);
    expect(versions).toEqual([...versions].sort((a: number, b: number) => b - a));
    expect(res.body.items[0].is_current).toBe(true);
    expect(res.body.items.slice(1).every((i: { is_current: boolean }) => !i.is_current)).toBe(true);
    const old = res.body.items[res.body.items.length - 1].version;
    expect((await http().get(`/v1/forms/${old}`).set('Authorization', `Bearer ${reporter}`).expect(200)).body.version).toBe(old);
    await http().get('/v1/forms/999999').set('Authorization', `Bearer ${reporter}`).expect(404);
    await http().get('/v1/forms/abc').set('Authorization', `Bearer ${reporter}`).expect(404);
    await http().get('/v1/forms/current?material_type=podcast').set('Authorization', `Bearer ${reporter}`).expect(400);
  });
});
