import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { base32Decode, totp } from '../../src/common/crypto';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

/**
 * دورة ما بعد الاعتماد (v0.1): رمز إعادة التعيين ← /auth/recovery/complete (كلمة مرور جديدة، سر TOTP معلّق، جلسة مقيّدة)
 * ← /auth/totp/confirm (جلسة كاملة). كل مسار آخر في الجلسة المقيّدة 403 credential_reset_required.
 */
describe('recovery completion (/auth/recovery/complete, /auth/totp/confirm)', () => {
  let h: Harness;
  let sup: Actor;
  let office: string;
  beforeAll(async () => {
    h = await createHarness();
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'Completion office', 'gaza') RETURNING id`)).rows[0]!.id;
    sup = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const newPassword = 'a brand new passphrase';

  /** مراسل في مكتب المشرف، بطلب استعادة معتمد؛ يعيد رمز إعادة التعيين كما سلّمه المشرف. */
  async function approved(): Promise<{ user: Awaited<ReturnType<typeof seedUser>>; requestId: string; resetToken: string }> {
    const user = await seedUser(h, { totp: true, roles: [{ role: 'reporter' }] });
    await h.pool.query(`UPDATE users SET office_id = $2 WHERE id = $1`, [user.id, office]);
    const requestId = (
      await h.pool.query<{ id: string }>(`INSERT INTO recovery_requests (user_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id`, [user.id])
    ).rows[0]!.id;
    const res = await http()
      .post(`/v1/auth/recovery/${requestId}/approve`)
      .set(bearer(sup.token))
      .set('Idempotency-Key', randomUUID())
      .send({ verification_note: 'verified in person' })
      .expect(200);
    return { user, requestId, resetToken: res.body.reset_token };
  }
  const complete = (reset_token: string, new_password = newPassword) => http().post('/v1/auth/recovery/complete').send({ reset_token, new_password });
  const confirm = (token: string, totp_code: string) => http().post('/v1/auth/totp/confirm').set(bearer(token)).send({ totp_code });
  const login = (email: string, password: string, totp_code?: string) => http().post('/v1/auth/login').send({ email, password, totp_code });

  it('approval puts the account in mandatory reset: the old password and TOTP no longer log in', async () => {
    const { user } = await approved();
    expect((await login(user.email, user.password, totp(user.totpSecret!, Date.now())).expect(401)).body.code).toBe('unauthorized');
  });

  it('complete: one use, new password, pending TOTP replaces the old secret at once, restricted session', async () => {
    const { user, requestId, resetToken } = await approved();
    const res = await complete(resetToken).expect(200);
    const valid = schemaValidator('RecoveryCompletion');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    const { secret_base32, otpauth_uri } = res.body.totp_enrollment;
    expect(otpauth_uri).toContain(`secret=${secret_base32}`);

    const { rows } = await h.pool.query(
      `SELECT u.totp_enabled, u.totp_secret_enc, u.totp_pending_secret_enc IS NOT NULL AS pending, u.credential_reset_required, r.completed_at IS NOT NULL AS completed
         FROM users u JOIN recovery_requests r ON r.user_id = u.id WHERE r.id = $1`,
      [requestId],
    );
    expect(rows[0]).toEqual({ totp_enabled: false, totp_secret_enc: null, pending: true, credential_reset_required: true, completed: true });
    // الرمز لا يُستعمل مرتين، ولا شيء منه في التدقيق
    expect((await complete(resetToken).expect(401)).body.code).toBe('unauthorized');
    const { rows: audits } = await h.pool.query(`SELECT action, details::text AS details FROM audit_log WHERE target_id = $1 ORDER BY id`, [user.id]);
    expect(audits.map((a) => a.action)).toEqual(['auth.recovery_approved', 'auth.reset_token_issued', 'auth.recovery_completed']);
    expect(JSON.stringify(audits)).not.toContain(resetToken);
    expect(JSON.stringify(audits)).not.toContain(secret_base32);

    // الجلسة المقيّدة: me والخروج والتأكيد فقط
    const restricted = res.body.session.access_token;
    const me = await http().get('/v1/auth/me').set(bearer(restricted)).expect(200);
    expect(me.body).toMatchObject({ user_id: user.id, credential_reset_required: true, totp_enabled: false });
    for (const [method, url] of [
      ['get', '/v1/auth/sessions'],
      ['get', '/v1/notifications'],
      ['get', '/v1/forms/current'],
    ] as const) {
      expect((await http()[method](url).set(bearer(restricted)).expect(403)).body.code).toBe('credential_reset_required');
    }
    const blocked = await http().post('/v1/materials').set(bearer(restricted)).set('Idempotency-Key', randomUUID()).send({}).expect(403);
    expect(blocked.body.code).toBe('credential_reset_required');
    // والدخول العادي بكلمة المرور الجديدة ممنوع حتى التأكيد
    await login(user.email, newPassword).expect(401);
  });

  it('confirm: a wrong code is 401, the right one activates the secret, revokes the restricted session and issues a full one', async () => {
    const { user, resetToken } = await approved();
    const done = (await complete(resetToken).expect(200)).body;
    const secret = base32Decode(done.totp_enrollment.secret_base32);
    const restricted = done.session.access_token;
    const now = totp(secret, Date.now());
    expect((await confirm(restricted, now === '000000' ? '111111' : '000000').expect(401)).body.code).toBe('unauthorized');

    const full = await confirm(restricted, now).expect(200);
    const valid = schemaValidator('Session');
    expect(valid(full.body) ? [] : valid.errors).toEqual([]);
    await http().get('/v1/auth/me').set(bearer(restricted)).expect(401);
    await http().post('/v1/auth/refresh').send({ refresh_token: done.session.refresh_token }).expect(401);
    const me = await http().get('/v1/auth/me').set(bearer(full.body.access_token)).expect(200);
    expect(me.body).toMatchObject({ credential_reset_required: false, totp_enabled: true });
    await http().get('/v1/auth/sessions').set(bearer(full.body.access_token)).expect(200);
    // لا شيء معلّق بعد التأكيد: 409، والدخول بالسر الجديد يعمل
    expect((await confirm(full.body.access_token, totp(secret, Date.now())).expect(409)).body.code).toBe('recovery_state_conflict');
    await login(user.email, newPassword, totp(secret, Date.now())).expect(200);
  });

  it('confirm outside a reset is 409; confirm is rate-limited per account', async () => {
    const plain = await loginAs(h, [{ role: 'reporter' }]);
    expect((await confirm(plain.token, '123456').expect(409)).body.code).toBe('recovery_state_conflict');

    const { resetToken } = await approved();
    const done = (await complete(resetToken).expect(200)).body;
    const secret = base32Decode(done.totp_enrollment.secret_base32);
    const wrong = totp(secret, Date.now()) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await confirm(done.session.access_token, wrong).expect(401);
    const limited = await confirm(done.session.access_token, totp(secret, Date.now())).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('the restricted session refreshes until reset_token_expires_at, then 401 on refresh and on use', async () => {
    const { requestId, resetToken } = await approved();
    const done = (await complete(resetToken).expect(200)).body;
    const refreshed = await http().post('/v1/auth/refresh').send({ refresh_token: done.session.refresh_token }).expect(200);
    await h.pool.query(`UPDATE recovery_requests SET reset_token_expires_at = now() - interval '1 second' WHERE id = $1`, [requestId]);
    await http().post('/v1/auth/refresh').send({ refresh_token: refreshed.body.refresh_token }).expect(401);
    await http().get('/v1/auth/me').set(bearer(refreshed.body.access_token)).expect(401);
  });

  it('an unknown, expired or malformed token is 401 or 422 and leaves nothing behind', async () => {
    const { user, requestId, resetToken } = await approved();
    const before = async () => (await h.pool.query(`SELECT password_hash, totp_enabled, totp_secret_enc FROM users WHERE id = $1`, [user.id])).rows[0];
    const original = await before();
    await complete('x'.repeat(43)).expect(401);
    await complete('short').expect(422);
    await complete(resetToken, 'short').expect(422);
    await h.pool.query(`UPDATE recovery_requests SET reset_token_expires_at = now() - interval '1 second' WHERE id = $1`, [requestId]);
    await complete(resetToken).expect(401);
    expect(await before()).toEqual(original);
    expect(original.totp_enabled).toBe(true);
  });

  it('a supervisor approval of a fresh request discards any pending secret of an earlier, unfinished one', async () => {
    const { user, resetToken } = await approved();
    await complete(resetToken).expect(200);
    const requestId = (
      await h.pool.query<{ id: string }>(`INSERT INTO recovery_requests (user_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id`, [user.id])
    ).rows[0]!.id;
    await http()
      .post(`/v1/auth/recovery/${requestId}/approve`)
      .set(bearer(sup.token))
      .set('Idempotency-Key', randomUUID())
      .send({ verification_note: 'second visit' })
      .expect(200);
    const { rows } = await h.pool.query(`SELECT totp_pending_secret_enc, credential_reset_required FROM users WHERE id = $1`, [user.id]);
    expect(rows[0]).toEqual({ totp_pending_secret_enc: null, credential_reset_required: true });
  });
});
