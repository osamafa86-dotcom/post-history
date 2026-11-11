import { Body, Controller, Inject, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import request from 'supertest';
import { ApiError } from '../../src/common/errors';
import { DB, type Database } from '../../src/database/database.module';
import { users } from '../../src/database/schema/schema';
import { IdempotencyInterceptor } from '../../src/idempotency/idempotency.interceptor';
import { createHarness, ensureForm, type Harness, loginAs } from './harness';

// مسار اختبار فقط: كل تنفيذ يكتب صفًّا حقيقيًّا (مستخدمًا ببريد يحمل علامة الطلب)، داخل معاملة أو خارجها، ثم يفشل حيث يُطلب منه.
let executions = 0;
const email = (marker: string) => `at-most-once-${marker}@example.test`;
const row = (marker: string) => ({ email: email(marker), passwordHash: 'not-a-hash' });

@Controller('test-commits')
class TestCommitsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Post('transaction')
  async inTransaction(@Body() body: { marker: string; fail?: 'in_transaction' | 'after_commit'; unstorable?: boolean }) {
    executions += 1;
    await this.db.transaction(async (tx) => {
      await tx.insert(users).values(row(body.marker));
      if (body.fail === 'in_transaction') throw new Error('boom');
    });
    if (body.fail === 'after_commit') throw new Error('boom');
    // محرف NUL لا يُحفظ في jsonb: حفظ الرد يفشل بعد أن التزمت معاملة المعالج
    return { marker: body.marker, note: body.unstorable ? 'a\u0000b' : 'ok' };
  }

  @Post('direct')
  async direct(@Body() body: { marker: string; fail?: 'after_write' }) {
    executions += 1;
    await this.db.insert(users).values(row(body.marker));
    if (body.fail === 'after_write') throw new Error('boom');
    return { marker: body.marker };
  }

  /** رفض (4xx) لا يُحفظ جسمه، بعد كتابة ملتزمة أو بلا كتابة. */
  @Post('rejected')
  async rejected(@Body() body: { marker?: string }) {
    executions += 1;
    if (body.marker) await this.db.insert(users).values(row(body.marker));
    throw new ApiError(409, 'invalid_transition', 'nope', { note: 'a\u0000b' });
  }

  /** يقرأ، ويقفل صفًّا، وينفّذ تعديلًا لا يمسّ صفًّا، داخل معاملات وخارجها، ثم يفشل: لم يتغيّر شيء. */
  @Post('no-change')
  async noChange() {
    executions += 1;
    const nobody = eq(users.email, email('nobody'));
    await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).limit(1);
    });
    await this.db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).limit(1).for('update');
    });
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ status: 'suspended' }).where(nobody);
    });
    await this.db.select({ id: users.id }).from(users).limit(1);
    await this.db.delete(users).where(nobody);
    throw new Error('boom');
  }
}

// ADR 0005 (تعديل 2026-11-11): المفتاح يُلتزم مع كتابة المعالج نفسها، وما التُزم لا يُحرَّر ولا يُتولّى، فلا تنفيذ ثانٍ
describe('Idempotency-Key: at most once', () => {
  const lines: string[] = [];
  let h: Harness;
  let user: Awaited<ReturnType<typeof loginAs>>;
  const http = () => request(h.app.getHttpServer());

  beforeAll(async () => {
    const logger = pino({ level: 'warn' }, { write: (line: string) => void lines.push(line) });
    h = await createHarness({ controllers: [TestCommitsController], logger });
    user = await loginAs(h, [{ role: 'reporter' }]);
    await ensureForm(h);
  });
  afterAll(() => h.close());
  beforeEach(() => {
    executions = 0;
    lines.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  const post = (path: string, key: string, body: object) =>
    http().post(`/v1/test-commits/${path}`).set('Authorization', `Bearer ${user.token}`).set('Idempotency-Key', key).send(body);
  const written = async (marker: string) =>
    Number((await h.pool.query(`SELECT count(*) AS n FROM users WHERE email = $1`, [email(marker)])).rows[0].n);
  const keyRow = async (key: string) =>
    (await h.pool.query(`SELECT state, response_status FROM idempotency_keys WHERE user_id = $1 AND key = $2`, [user.id, key])).rows[0];
  const settleFailures = () =>
    lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'idempotency settle failed')
      .map(({ level: _l, time: _t, pid: _p, hostname: _h, msg: _m, ...fields }) => fields);

  it('stores a successful request as completed and replays it', async () => {
    const [key, marker] = [randomUUID(), randomUUID()];
    const first = await post('transaction', key, { marker }).expect(201);
    expect(await keyRow(key)).toEqual({ state: 'completed', response_status: 201 });
    const replay = await post('transaction', key, { marker }).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect([executions, await written(marker)]).toEqual([1, 1]);
  });

  it('returns the response when it cannot be stored after the handler committed, and spends the key', async () => {
    const [key, marker] = [randomUUID(), randomUUID()];
    const body = { marker, unstorable: true };
    const first = await post('transaction', key, body);
    expect(first.status).toBe(201);
    expect(first.body.marker).toBe(marker);
    expect(await keyRow(key)).toEqual({ state: 'committed', response_status: null });
    // اسم الخطأ ورمزه ومعرّف الطلب وحدها: لا مفتاح ولا جسم
    expect(settleFailures()).toEqual([{ request_id: expect.any(String), err_name: expect.any(String), pg_code: '22P05' }]);

    const retry = await post('transaction', key, body).expect(409);
    expect(retry.body.code).toBe('idempotency_in_progress');
    // مهلة «قيد التنفيذ» تخص الحجز الذي لم يلتزم؛ الملتزَم لا يتولاه تكرار
    await h.pool.query(`UPDATE idempotency_keys SET created_at = now() - interval '6 minutes' WHERE user_id = $1 AND key = $2`, [user.id, key]);
    await post('transaction', key, body).expect(409);
    expect([executions, await written(marker)]).toEqual([1, 1]);
  });

  it('keeps the key when the handler fails after its transaction committed: the retry is refused, not executed', async () => {
    const [key, marker] = [randomUUID(), randomUUID()];
    const body = { marker, fail: 'after_commit' };
    await post('transaction', key, body).expect(500);
    expect(await keyRow(key)).toEqual({ state: 'committed', response_status: null });
    expect((await post('transaction', key, body).expect(409)).body.code).toBe('idempotency_in_progress');
    expect([executions, await written(marker)]).toEqual([1, 1]);
  });

  it('releases the key when the failed transaction rolled back: the retry executes', async () => {
    const [key, marker] = [randomUUID(), randomUUID()];
    const body = { marker, fail: 'in_transaction' };
    await post('transaction', key, body).expect(500);
    expect(await keyRow(key)).toBeUndefined();
    await post('transaction', key, body).expect(500);
    expect([executions, await written(marker)]).toEqual([2, 0]);
  });

  it('releases the key when the failed request read, locked a row or changed no row', async () => {
    const key = randomUUID();
    await post('no-change', key, {}).expect(500);
    expect(await keyRow(key)).toBeUndefined();
    await post('no-change', key, {}).expect(500);
    expect(executions).toBe(2);
  });

  it('commits a write made outside a transaction together with its key', async () => {
    const [key, marker] = [randomUUID(), randomUUID()];
    const body = { marker, fail: 'after_write' };
    await post('direct', key, body).expect(500);
    expect(await keyRow(key)).toEqual({ state: 'committed', response_status: null });
    expect((await post('direct', key, body).expect(409)).body.code).toBe('idempotency_in_progress');
    expect([executions, await written(marker)]).toEqual([1, 1]);
  });

  it('leaves the key free when a write outside a transaction is rejected', async () => {
    const marker = randomUUID();
    await post('direct', randomUUID(), { marker }).expect(201);
    // البريد نفسه مرة ثانية: القاعدة ترفض الصف، فلا كتابة ولا التزام للمفتاح
    const key = randomUUID();
    await post('direct', key, { marker }).expect(500);
    expect(await keyRow(key)).toBeUndefined();
    expect(await written(marker)).toBe(1);
  });

  it('a rejection (4xx) that cannot be stored releases the key only when nothing was written', async () => {
    const free = randomUUID();
    expect((await post('rejected', free, {}).expect(409)).body.code).toBe('invalid_transition');
    expect(await keyRow(free)).toBeUndefined();
    expect(settleFailures()).toHaveLength(1);
    expect((await post('rejected', free, {}).expect(409)).body.code).toBe('invalid_transition');
    expect(executions).toBe(2);

    const [spent, marker] = [randomUUID(), randomUUID()];
    expect((await post('rejected', spent, { marker }).expect(409)).body.code).toBe('invalid_transition');
    expect(await keyRow(spent)).toEqual({ state: 'committed', response_status: null });
    expect((await post('rejected', spent, { marker }).expect(409)).body.code).toBe('idempotency_in_progress');
    expect([executions, await written(marker)]).toEqual([3, 1]);
  });

  it('POST /materials: one material and one event when storing the response fails and the client retries', async () => {
    const complete = jest.spyOn(IdempotencyInterceptor.prototype as never, 'complete').mockRejectedValueOnce(new Error('settle failed') as never);
    const key = randomUUID();
    const title = `at-most-once ${randomUUID()}`;
    const create = () =>
      http()
        .post('/v1/materials')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', key)
        .send({
          title,
          material_types: ['report'],
          governorate: 'gaza',
          city: 'gaza',
          priority: 'normal',
          sensitivity: { minors: false, injured: false, graphic: false },
          display_name: { mode: 'network' },
          form_version: 1,
          dynamic_fields: {},
        });
    const first = await create().expect(201);
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await create().expect(409)).body.code).toBe('idempotency_in_progress');

    const { rows } = await h.pool.query(`SELECT id FROM materials WHERE title = $1`, [title]);
    expect(rows.map((r) => r.id)).toEqual([first.body.id]);
    const events = await h.pool.query(`SELECT 1 FROM outbox_events WHERE type = 'material.created' AND aggregate_id = $1`, [first.body.id]);
    expect(events.rowCount).toBe(1);
  });
});
