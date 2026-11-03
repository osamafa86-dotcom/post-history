import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, drainOutbox, type Harness, loginAs } from './harness';

/**
 * الرموز الاحتياطية (ADR 0107): كانت تُستهلك في POST /auth/recovery ولا يصدرها شيء. صاحب الحساب يولّد عشرة تُعرض مرة وتبطل ما قبلها،
 * والرمز يفتح طلب استعادة ينتظر الاعتماد كما كان.
 */
describe('backup codes (GET/POST /auth/recovery-codes)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const status = (token: string) => http().get('/v1/auth/recovery-codes').set(bearer(token));
  const generate = (token: string) => http().post('/v1/auth/recovery-codes').set(bearer(token));
  const start = (email: string, backup_code: string) => http().post('/v1/auth/recovery').send({ email, backup_code }).expect(202);
  const requests = async (userId: string) =>
    (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM recovery_requests WHERE user_id = $1`, [userId])).rows[0]!.n;

  it('generates ten codes shown once, stored as digests, audited and announced by count only', async () => {
    const u = await loginAs(h, [{ role: 'producer' }]);
    expect((await status(u.token).expect(200)).body).toEqual({ remaining: 0, generated_at: null });
    const res = await generate(u.token).expect(200);
    const valid = schemaValidator('RecoveryCodes');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    const codes: string[] = res.body.codes;
    expect(new Set(codes).size).toBe(10);
    const st = (await status(u.token).expect(200)).body;
    expect(st).toEqual({ remaining: 10, generated_at: res.body.generated_at });

    const { rows: stored } = await h.pool.query<{ code_hash: Buffer }>(`SELECT code_hash FROM recovery_codes WHERE user_id = $1`, [u.id]);
    expect(stored.map((r) => r.code_hash.toString('hex')).sort()).toEqual(codes.map((c) => createHash('sha256').update(c).digest('hex')).sort());
    const { rows: audits } = await h.pool.query(`SELECT details FROM audit_log WHERE target_id = $1 AND action = 'auth.recovery_codes_generated'`, [u.id]);
    expect(audits).toEqual([{ details: { target_user_id: u.id, codes_count: '10' } }]);
    const { rows: events } = await h.pool.query(`SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND type = 'auth.recovery_codes_generated'`, [u.id]);
    expect(events).toEqual([{ payload: { codes_count: 10 } }]);
    await drainOutbox(h);
    const { rows: alert } = await h.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'auth.recovery_codes_generated'`, [u.id]);
    expect(alert[0].n).toBe(1);
    for (const table of ['audit_log', 'outbox_events', 'idempotency_keys', 'notifications']) {
      const { rows } = await h.pool.query(`SELECT t::text AS row FROM ${table} t`);
      for (const c of codes) expect(rows.filter((r) => r.row.includes(c))).toEqual([]);
    }
  });

  it('a code opens a recovery request once; a new set makes the old codes worthless', async () => {
    const u = await loginAs(h, [{ role: 'producer' }]);
    const first: string[] = (await generate(u.token).expect(200)).body.codes;
    await start(u.email, first[0]!);
    expect(await requests(u.id)).toBe(1);
    expect((await status(u.token).expect(200)).body.remaining).toBe(9);
    await start(u.email, first[0]!);
    expect(await requests(u.id)).toBe(1);

    // الطلب يبطل الجلسات حين يُعتمد لا قبل ذلك، فالجلسة ما زالت تولّد مجموعة جديدة
    const second: string[] = (await generate(u.token).expect(200)).body.codes;
    expect((await status(u.token).expect(200)).body.remaining).toBe(10);
    await start(u.email, first[1]!);
    expect(await requests(u.id)).toBe(1);
    await start(u.email, second[0]!);
    expect(await requests(u.id)).toBe(2);
  });

  it('is rate-limited per account and closed to a restricted session', async () => {
    const u = await loginAs(h, [{ role: 'producer' }]);
    for (let i = 0; i < 5; i++) await generate(u.token).expect(200);
    const limited = await generate(u.token).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const r = await loginAs(h, [{ role: 'producer' }]);
    await h.pool.query(`UPDATE users SET credential_reset_required = true WHERE id = $1`, [r.id]);
    await h.pool.query(
      `INSERT INTO recovery_requests (user_id, state, approved_by, verification_note, decided_at, expires_at, reset_token_hash,
                                      reset_token_expires_at, completed_at)
       VALUES ($1, 'approved', $1, 'test', now(), now() + interval '1 hour', $2, now() + interval '1 hour', now())`,
      [r.id, randomBytes(32)],
    );
    expect((await generate(r.token).expect(403)).body.code).toBe('credential_reset_required');
    expect((await status(r.token).expect(403)).body.code).toBe('credential_reset_required');
    await http().post('/v1/auth/recovery-codes').set('Idempotency-Key', randomUUID()).expect(401);
  });
});
