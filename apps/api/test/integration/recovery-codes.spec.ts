import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, drainOutbox, freshTotp, type Harness, loginAs, seedUser } from './harness';

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
  // إعادة التحقق في الجسم (ADR 0117): كلمة المرور لحساب بلا TOTP
  const generate = (u: { token: string; password: string }, body: object = { password: u.password }) =>
    http().post('/v1/auth/recovery-codes').set(bearer(u.token)).send(body);
  const start = (email: string, backup_code: string) => http().post('/v1/auth/recovery').send({ email, backup_code }).expect(202);
  const requests = async (userId: string) =>
    (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM recovery_requests WHERE user_id = $1`, [userId])).rows[0]!.n;

  it('generates ten codes shown once, stored as digests, audited and announced by count only', async () => {
    const u = await loginAs(h, [{ role: 'producer' }]);
    expect((await status(u.token).expect(200)).body).toEqual({ remaining: 0, generated_at: null });
    const res = await generate(u).expect(200);
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
    const first: string[] = (await generate(u).expect(200)).body.codes;
    await start(u.email, first[0]!);
    expect(await requests(u.id)).toBe(1);
    expect((await status(u.token).expect(200)).body.remaining).toBe(9);
    await start(u.email, first[0]!);
    expect(await requests(u.id)).toBe(1);

    // الطلب يبطل الجلسات حين يُعتمد لا قبل ذلك، فالجلسة ما زالت تولّد مجموعة جديدة
    const second: string[] = (await generate(u).expect(200)).body.codes;
    expect((await status(u.token).expect(200)).body.remaining).toBe(10);
    await start(u.email, first[1]!);
    expect(await requests(u.id)).toBe(1);
    await start(u.email, second[0]!);
    expect(await requests(u.id)).toBe(2);
  });

  it('is rate-limited per account and closed to a restricted session', async () => {
    const u = await loginAs(h, [{ role: 'producer' }]);
    for (let i = 0; i < 5; i++) await generate(u).expect(200);
    const limited = await generate(u).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    const r = await loginAs(h, [{ role: 'producer' }]);
    await h.pool.query(`UPDATE users SET credential_reset_required = true WHERE id = $1`, [r.id]);
    await h.pool.query(
      `INSERT INTO recovery_requests (user_id, state, approved_by, verification_note, decided_at, expires_at, reset_token_hash,
                                      reset_token_expires_at, completed_at)
       VALUES ($1, 'approved', $1, 'test', now(), now() + interval '1 hour', $2, now() + interval '1 hour', now())`,
      [r.id, randomBytes(32)],
    );
    expect((await generate(r).expect(403)).body.code).toBe('credential_reset_required');
    expect((await status(r.token).expect(403)).body.code).toBe('credential_reset_required');
    await http().post('/v1/auth/recovery-codes').set('Idempotency-Key', randomUUID()).expect(401);
  });

  // ADR 0117: جلسة مسروقة وحدها لا تأخذ رموزًا ولا تبطل رموز صاحبها
  it('needs the password again, and TOTP when enabled; a code already used to sign in is refused', async () => {
    const u = await seedUser(h, { totp: true, roles: [{ role: 'producer' }] });
    const loginCode = freshTotp(u.id, u.totpSecret!);
    const token = (await http().post('/v1/auth/login').send({ email: u.email, password: u.password, totp_code: loginCode }).expect(200)).body.access_token;
    const actor = { token, password: u.password };
    // بلا جسم (العميل القائم) 401؛ وجسم بلا كلمة مرور يُرفض بالمخطط كما في registration-options
    await http().post('/v1/auth/recovery-codes').set(bearer(token)).expect(401);
    expect((await generate(actor, {}).expect(422)).body.code).toBe('validation_failed');
    expect((await generate(actor, { password: 'not the password' }).expect(401)).body.code).toBe('unauthorized');
    expect((await generate(actor, { password: u.password }).expect(401)).body.code).toBe('totp_required');
    expect((await generate(actor, { password: u.password, totp_code: 'abc' }).expect(422)).body.code).toBe('validation_failed');
    // الرمز الذي دخل به لا يُقبل ثانية في خطوته
    expect((await generate(actor, { password: u.password, totp_code: loginCode }).expect(401)).body.code).toBe('unauthorized');
    expect(await h.pool.query(`SELECT 1 FROM recovery_codes WHERE user_id = $1`, [u.id]).then((r) => r.rowCount)).toBe(0);
    const res = await generate(actor, { password: u.password, totp_code: freshTotp(u.id, u.totpSecret!) }).expect(200);
    expect(res.body.codes).toHaveLength(10);
  });

  it('a credential reset deletes every backup code of the account', async () => {
    const u = await loginAs(h, [{ role: 'reporter' }]);
    const codes: string[] = (await generate(u).expect(200)).body.codes;
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    await http()
      .post(`/v1/users/${u.id}/password-reset-links`)
      .set(bearer(admin.token))
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'lost_device' })
      .expect(201);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1`, [u.id])).rows[0].n).toBe(0);
    await start(u.email, codes[0]!);
    expect(await h.pool.query(`SELECT count(*)::int AS n FROM recovery_requests WHERE user_id = $1 AND state = 'pending_approval'`, [u.id]).then((r) => r.rows[0].n)).toBe(0);
  });
});
