import request from 'supertest';
import { totp } from '../../src/common/crypto';
import { UNAUTHORIZED_MESSAGE } from '../../src/common/errors';
import { createHarness, type Harness, seedUser } from './harness';

describe('auth (/v1/auth/*)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const login = (body: object) => http().post('/v1/auth/login').send(body);

  it('logs in and returns a session matching the contract', async () => {
    const user = await seedUser(h, { roles: [{ role: 'supervisor', scopeKind: 'office', scopeId: 'o-1' }] });
    const res = await login({ email: user.email.toUpperCase(), password: user.password }).expect(200);
    expect(res.body).toEqual({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      expires_at: expect.any(String),
      user_id: user.id,
      roles: [{ name: 'supervisor', scopes: [{ kind: 'office', id: 'o-1' }] }],
    });
    const ttl = new Date(res.body.expires_at).getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);
    // رمز التحديث مُجزَّأ فقط
    const { rows } = await h.pool.query(`SELECT token_hash FROM refresh_tokens WHERE user_id = $1`, [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash.toString('base64url')).not.toEqual(res.body.refresh_token);
  });

  it('returns the same 401 for unknown email, wrong password and suspended account', async () => {
    const user = await seedUser(h);
    const suspended = await seedUser(h, { status: 'suspended' });
    const responses = await Promise.all([
      login({ email: 'nobody@example.test', password: 'whatever-123' }),
      login({ email: user.email, password: 'wrong-password' }),
      login({ email: suspended.email, password: suspended.password }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'unauthorized', message: UNAUTHORIZED_MESSAGE, request_id: expect.any(String) });
    }
  });

  it('requires TOTP after the password when enabled, and rejects a wrong code with the generic 401', async () => {
    const user = await seedUser(h, { totp: true });
    const missing = await login({ email: user.email, password: user.password }).expect(401);
    expect(missing.body.code).toBe('totp_required');
    // كلمة مرور خاطئة لا تكشف أن الحساب يطلب TOTP
    const wrongPw = await login({ email: user.email, password: 'wrong-password' }).expect(401);
    expect(wrongPw.body.code).toBe('unauthorized');
    const wrong = await login({ email: user.email, password: user.password, totp_code: '000000' });
    if (totp(user.totpSecret!, Date.now()) !== '000000') expect(wrong.body.code).toBe('unauthorized');
    await login({ email: user.email, password: user.password, totp_code: totp(user.totpSecret!, Date.now()) }).expect(200);
  });

  it('validates the body against the contract (422 without values)', async () => {
    const res = await login({ email: 'not-an-email', password: 'short' }).expect(422);
    expect(res.body.code).toBe('validation_failed');
    expect(JSON.stringify(res.body)).not.toContain('not-an-email');
  });

  it('rate-limits login attempts per email with Retry-After', async () => {
    const user = await seedUser(h);
    for (let i = 0; i < 5; i++) await login({ email: user.email, password: 'wrong-password' }).expect(401);
    const res = await login({ email: user.email, password: user.password }).expect(429);
    expect(res.body.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('GET /auth/me returns roles and active permissions; 401 without a token', async () => {
    const user = await seedUser(h, { roles: [{ role: 'reporter' }, { role: 'system_admin' }] });
    await h.pool.query(
      `INSERT INTO user_permissions (user_id, permission, granted_by, reason) VALUES ($1, 'protected_source:read', $1, 'test')`,
      [user.id],
    );
    const { body: session } = await login({ email: user.email, password: user.password }).expect(200);
    const me = await http().get('/v1/auth/me').set('Authorization', `Bearer ${session.access_token}`).expect(200);
    expect(me.body).toEqual({
      user_id: user.id,
      email: user.email,
      office_id: null,
      totp_enabled: false,
      roles: [
        { name: 'reporter', scopes: [] },
        { name: 'system_admin', scopes: [] },
      ],
      permissions: ['protected_source:read'],
    });
    const anon = await http().get('/v1/auth/me').expect(401);
    expect(anon.body.message).toBe(UNAUTHORIZED_MESSAGE);
    await http().get('/v1/auth/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
  });

  it('rotates refresh tokens; the old access token stays valid while its session is', async () => {
    const user = await seedUser(h);
    const { body: s1 } = await login({ email: user.email, password: user.password }).expect(200);
    const { body: s2 } = await http().post('/v1/auth/refresh').send({ refresh_token: s1.refresh_token }).expect(200);
    expect(s2.refresh_token).not.toEqual(s1.refresh_token);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${s1.access_token}`).expect(200);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${s2.access_token}`).expect(200);
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS active FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    expect(rows[0].active).toBe(1);
  });

  it('treats reuse of a rotated refresh token as theft and revokes the whole session', async () => {
    const user = await seedUser(h);
    const { body: s1 } = await login({ email: user.email, password: user.password }).expect(200);
    const { body: s2 } = await http().post('/v1/auth/refresh').send({ refresh_token: s1.refresh_token }).expect(200);
    await http().post('/v1/auth/refresh').send({ refresh_token: s1.refresh_token }).expect(401);
    await http().post('/v1/auth/refresh').send({ refresh_token: s2.refresh_token }).expect(401);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${s2.access_token}`).expect(401);
  });

  it('logout revokes the current session immediately; other sessions survive', async () => {
    const user = await seedUser(h);
    const { body: a } = await login({ email: user.email, password: user.password }).expect(200);
    const { body: b } = await login({ email: user.email, password: user.password }).expect(200);
    await http().post('/v1/auth/logout').set('Authorization', `Bearer ${a.access_token}`).expect(204);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${a.access_token}`).expect(401);
    await http().post('/v1/auth/refresh').send({ refresh_token: a.refresh_token }).expect(401);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${b.access_token}`).expect(200);
  });

  it('logout with all_sessions revokes every session and open upload tokens', async () => {
    const user = await seedUser(h);
    const { body: a } = await login({ email: user.email, password: user.password }).expect(200);
    const { body: b } = await login({ email: user.email, password: user.password }).expect(200);
    const { seedUploadSession } = await import('./harness');
    const upload = await seedUploadSession(h, user.id);
    await http()
      .post('/v1/auth/logout')
      .set('Authorization', `Bearer ${a.access_token}`)
      .send({ all_sessions: true })
      .expect(204);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${b.access_token}`).expect(401);
    await http().post('/v1/auth/refresh').send({ refresh_token: b.refresh_token }).expect(401);
    const { rows } = await h.pool.query(`SELECT upload_token_hash FROM upload_sessions WHERE id = $1`, [upload.id]);
    expect(rows[0].upload_token_hash).toBeNull();
  });

  it('suspending a user cuts off existing access tokens on the next request', async () => {
    const user = await seedUser(h);
    const { body: s } = await login({ email: user.email, password: user.password }).expect(200);
    await h.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${s.access_token}`).expect(401);
  });
});
