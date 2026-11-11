import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { toErrorResponse } from '../../src/common/error.filter';
import { DB, type Database, PG_POOL } from '../../src/database/database.module';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { VerificationWorker } from '../../src/verification/verification.worker';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

const LIMIT_MS = 400;

/** تخزين في الذاكرة يتأخر في قراءة الرأس، ليبقى المتحقق في معاملته أطول من مهلة المعاملة الخاملة. */
class SlowStorage implements ObjectStorage {
  objects = new Map<string, Buffer>();
  delayMs = 0;
  async head(_bucket: string, key: string) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async read(_bucket: string, key: string) {
    return Readable.from([this.objects.get(key)!]);
  }
}

// ADR 0028 (تعديل 2026-11-11): انقطاع القاعدة لا يُسقط الخادم، ولكل استعلام ومعاملة خاملة وانتظار اتصال مهلة، وما يتجاوزها 503
describe('database connection loss and time limits', () => {
  const lines: string[] = [];
  const storage = new SlowStorage();
  let h: Harness;
  let appPool: Pool;
  let reporter: Awaited<ReturnType<typeof loginAs>>;
  const http = () => request(h.app.getHttpServer());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** سطور «انقطع اتصال القاعدة» بلا حقول pino الثابتة. */
  const lost = () =>
    lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'database connection lost')
      .map(({ level: _l, time: _t, pid: _p, hostname: _h, msg: _m, ...fields }) => fields);

  beforeAll(async () => {
    const logger = pino({ level: 'warn' }, { write: (line: string) => void lines.push(line) });
    h = await createHarness({
      logger,
      env: { DATABASE_STATEMENT_TIMEOUT_MS: String(LIMIT_MS), DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: String(LIMIT_MS) },
      overrides: [[OBJECT_STORAGE, storage]],
    });
    appPool = h.app.get<Pool>(PG_POOL);
    reporter = await loginAs(h, [{ role: 'reporter' }]);
  });
  afterAll(() => h.close());

  it('applies both limits to every pooled connection', async () => {
    const { rows } = await appPool.query<{ statement: string; idle: string }>(
      `SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`,
    );
    expect(rows[0]).toEqual({ statement: `${LIMIT_MS}ms`, idle: `${LIMIT_MS}ms` });
  });

  it('survives the server closing an idle connection: logs its name and code only, once, and keeps serving', async () => {
    const before = lost().length;
    const { rows } = await appPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await h.pool.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);

    for (let i = 0; i < 50 && lost().length === before; i++) await sleep(20);
    await sleep(50);
    // اسم الخطأ ورمزه وحدهما: لا رسالة ولا مكدّس ولا معاملات اتصال
    expect(lost().slice(before)).toEqual([{ err_name: 'error', pg_code: '57P01' }]);

    expect((await http().get('/health').expect(200)).body.status).toBe('ok');
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(200);
  });

  it('ends a transaction left idle past its limit: its caller is told to retry and the connection is replaced', async () => {
    const before = lost().length;
    const db = h.app.get<Database>(DB);
    const failure = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await sleep(LIMIT_MS * 2);
        await tx.execute(sql`SELECT 1`);
      })
      .catch((err: unknown) => err);
    expect(toErrorResponse(failure, 'r')).toMatchObject({ status: 503, headers: { 'Retry-After': expect.any(String) } });
    expect(lost().slice(before)).toContainEqual({ err_name: 'error', pg_code: '25P03' });

    expect((await http().get('/health').expect(200)).body.status).toBe('ok');
  });

  it('answers 503 with Retry-After when a statement exceeds its limit, and leaves the Idempotency-Key free for the retry', async () => {
    const { materialId } = await seedUploadSession(h, reporter.id);
    const key = randomUUID();
    const patch = () =>
      http()
        .patch(`/v1/materials/${materialId}`)
        .set('Authorization', `Bearer ${reporter.token}`)
        .set('Idempotency-Key', key)
        .send({ city: 'rafah' });

    // قفل الصف يُمسَك مدة أطول من المهلة ثم يُحرَّر وحده، فالطلب لا ينتظر بلا نهاية إن لم تُطبَّق المهلة
    const blocker = await h.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM materials WHERE id = $1 FOR UPDATE', [materialId]);
    const unlocked = sleep(LIMIT_MS * 4).then(() => blocker.query('ROLLBACK'));
    try {
      const refused = await patch();
      expect(refused.status).toBe(503);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(refused.body).toMatchObject({ code: 'internal_error', request_id: expect.any(String) });
    } finally {
      await unlocked;
      blocker.release();
    }
    const retried = await patch().expect(200);
    expect(retried.body.city).toBe('rafah');
  });

  it('lets the in-process verifier hold its transaction through a storage read longer than the idle limit', async () => {
    await h.pool.query(`UPDATE upload_sessions SET state = 'failed', failure_reason = 'aborted' WHERE state = 'completed'`);
    const content = randomBytes(2000);
    const s = await seedUploadSession(h, reporter.id, { size: content.length });
    await h.pool.query(`UPDATE upload_sessions SET state = 'completed', storage_key = $2 WHERE id = $1`, [s.id, `tus/${s.id}`]);
    await h.pool.query(`UPDATE materials SET technical_state = 'original_received' WHERE id = $1`, [s.materialId]);
    storage.objects.set(`tus/${s.id}`, content);
    storage.delayMs = LIMIT_MS * 2;

    expect(await h.app.get(VerificationWorker).verifyNext()).toBe(true);
    const { rows } = await h.pool.query(`SELECT state, sha256 FROM material_files WHERE material_id = $1 AND kind = 'original'`, [s.materialId]);
    expect(rows[0]).toEqual({ state: 'verified', sha256: createHash('sha256').update(content).digest() });
  });

  it('answers 503 with Retry-After instead of waiting without end when every pooled connection is busy', async () => {
    const held = await Promise.all(Array.from({ length: h.config.DATABASE_POOL_MAX }, () => appPool.connect()));
    try {
      const started = Date.now();
      const refused = await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`);
      expect(refused.status).toBe(503);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      for (const client of held) client.release();
    }
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(200);
  }, 15_000);
});

describe('database unreachable', () => {
  let h: Harness;
  beforeAll(async () => {
    // منفذ لا يستمع عليه شيء: الاتصال يُرفض فورًا كما لو توقفت القاعدة
    h = await createHarness({ env: { DATABASE_URL: 'postgres://nobody@localhost:1/none' } });
  });
  afterAll(() => h.close());

  it('answers 503 with Retry-After on a request that needs the database, and /health reports unavailable', async () => {
    const res = await request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: 'someone@example.test', password: 'not-a-real-password' });
    expect(res.status).toBe(503);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.body).toMatchObject({ code: 'internal_error', request_id: expect.any(String) });

    const health = await request(h.app.getHttpServer()).get('/health');
    expect(health.status).toBe(503);
    expect(health.body.status).toBe('unavailable');
  });
});
