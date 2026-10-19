import { Body, Controller, Delete, HttpCode, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApiError } from '../../src/common/errors';
import { createHarness, type Harness, seedUser } from './harness';

// مسار اختبار فقط: يعدّ مرات التنفيذ الفعلي ليُثبت أن التكرار لا يعيد التنفيذ.
let executions = 0;
let gate: Promise<void> | undefined;

@Controller('test-writes')
class TestWritesController {
  @Post()
  async create(@Body() body: { value?: string; fail?: string }) {
    executions += 1;
    if (gate) await gate;
    if (body.fail === '409') throw new ApiError(409, 'invalid_transition', 'nope');
    if (body.fail === '500') throw new Error('boom');
    return { id: randomUUID(), value: body.value ?? null };
  }

  @Delete()
  @HttpCode(204)
  remove(): void {
    executions += 1;
  }
}

describe('Idempotency-Key', () => {
  let h: Harness;
  let token: string;
  let userId: string;
  beforeAll(async () => {
    h = await createHarness({ controllers: [TestWritesController] });
    const user = await seedUser(h);
    userId = user.id;
    const res = await request(h.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: user.email, password: user.password });
    token = res.body.access_token;
  });
  afterAll(() => h.close());
  beforeEach(() => {
    executions = 0;
    gate = undefined;
  });

  const post = (key: string | undefined, body: object) => {
    const r = request(h.app.getHttpServer()).post('/v1/test-writes').set('Authorization', `Bearer ${token}`);
    if (key) r.set('Idempotency-Key', key);
    return r.send(body);
  };

  it('replays the first response (status and body) for the same key and body without re-executing', async () => {
    const key = randomUUID();
    const first = await post(key, { value: 'a', extra: 1 }).expect(201);
    const second = await post(key, { extra: 1, value: 'a' }).expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(executions).toBe(1);
  });

  it('rejects the same key with a different body with 422 idempotency_key_reused', async () => {
    const key = randomUUID();
    await post(key, { value: 'a' }).expect(201);
    const res = await post(key, { value: 'b' }).expect(422);
    expect(res.body.code).toBe('idempotency_key_reused');
    expect(executions).toBe(1);
  });

  it('rejects a concurrent duplicate with 409 idempotency_in_progress', async () => {
    const key = randomUUID();
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const first = post(key, { value: 'a' });
    const firstDone = first.then((r) => r);
    // انتظر حتى يبدأ التنفيذ الأول (المفتاح محجوز)
    while (executions === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await post(key, { value: 'a' }).expect(409);
    expect(second.body.code).toBe('idempotency_in_progress');
    release();
    expect((await firstDone).status).toBe(201);
  });

  it('a request stuck in progress past the 5-minute lease is taken over by a retry with the same body', async () => {
    const key = randomUUID();
    await post(key, { value: 'a' }).expect(201);
    const stuck = async (age: string) =>
      h.pool.query(
        `UPDATE idempotency_keys SET state = 'in_progress', response_status = NULL, response_body = NULL,
           created_at = now() - $3::interval WHERE user_id = $1 AND key = $2`,
        [userId, key, age],
      );
    await stuck('4 minutes');
    expect((await post(key, { value: 'a' }).expect(409)).body.code).toBe('idempotency_in_progress');
    await stuck('6 minutes');
    // جسم مختلف لا يتولى الحجز المتروك
    expect((await post(key, { value: 'b' }).expect(422)).body.code).toBe('idempotency_key_reused');
    await post(key, { value: 'a' }).expect(201);
    expect(executions).toBe(2);
  });

  it('an expired key (24h) is reusable, even with a different body', async () => {
    const key = randomUUID();
    await post(key, { value: 'a' }).expect(201);
    await h.pool.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1`, [key]);
    await post(key, { value: 'b' }).expect(201);
    expect(executions).toBe(2);
  });

  it('stores 4xx outcomes and replays them; 5xx releases the key for a retry', async () => {
    const k4 = randomUUID();
    await post(k4, { fail: '409' }).expect(409);
    const replay = await post(k4, { fail: '409' }).expect(409);
    expect(replay.body.code).toBe('invalid_transition');
    expect(executions).toBe(1);

    const k5 = randomUUID();
    await post(k5, { fail: '500' }).expect(500);
    await post(k5, { fail: '500' }).expect(500);
    expect(executions).toBe(3);
  });

  it('keys are scoped per user', async () => {
    const key = randomUUID();
    await post(key, { value: 'a' }).expect(201);
    const other = await seedUser(h);
    const login = await request(h.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: other.email, password: other.password });
    await request(h.app.getHttpServer())
      .post('/v1/test-writes')
      .set('Authorization', `Bearer ${login.body.access_token}`)
      .set('Idempotency-Key', key)
      .send({ value: 'b' })
      .expect(201);
    expect(executions).toBe(2);
  });

  it('requires a well-formed key on writes outside /auth (422)', async () => {
    expect((await post(undefined, {}).expect(422)).body.code).toBe('validation_failed');
    await post('short', {}).expect(422);
    expect(executions).toBe(0);
  });

  it('replays 204 responses without a body', async () => {
    const key = randomUUID();
    const del = () =>
      request(h.app.getHttpServer()).delete('/v1/test-writes').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key);
    await del().expect(204);
    const again = await del().expect(204);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(executions).toBe(1);
  });

  it('never applies to /auth/* (responses carry tokens)', async () => {
    const { rows: before } = await h.pool.query(`SELECT count(*)::int AS n FROM idempotency_keys`);
    await request(h.app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .expect(204);
    const { rows: after } = await h.pool.query(`SELECT count(*)::int AS n FROM idempotency_keys`);
    expect(after[0].n).toBe(before[0].n);
  });
});
