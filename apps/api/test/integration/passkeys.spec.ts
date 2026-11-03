import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { totp } from '../../src/common/crypto';
import { schemaValidator } from '../../src/common/contract';
import { userHandle } from '../../src/identity/passkeys.service';
import { SoftAuthenticator } from '../support/soft-authenticator';
import { createHarness, drainOutbox, type Harness, seedUser, type SeededUser } from './harness';

const ORIGIN = 'http://localhost:3000';
const RP_ID = 'localhost';

/**
 * مفاتيح المرور (ADR 0107) على الخادم الحقيقي بمصادِق برمجي: إعادة التحقق قبل التسجيل، والتحدي لمرة واحدة ببصمته، والمصدر وRP ID
 * من البيئة، والدخول بلا TOTP، والإبطال، والحد، وألّا يخرج التحدي أو معرّف الاعتماد إلى قاعدة أو سجل أو حدث.
 */
describe('passkeys (WebAuthn registration, sign-in, list and revoke)', () => {
  let h: Harness;
  const device = new SoftAuthenticator(ORIGIN, RP_ID);
  beforeAll(async () => {
    h = await createHarness({ env: { WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_ORIGINS: `${ORIGIN},https://web.localhost` } });
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const valid = (name: string, body: unknown) => {
    const v = schemaValidator(name);
    return v(body) ? [] : v.errors;
  };

  async function signedIn(opts: { totp?: boolean; roles?: Array<{ role: string }> } = {}): Promise<SeededUser & { token: string }> {
    const user = await seedUser(h, { totp: opts.totp, roles: opts.roles ?? [{ role: 'editor_in_chief' }] });
    const res = await http()
      .post('/v1/auth/login')
      .send({ email: user.email, password: user.password, ...(user.totpSecret ? { totp_code: totp(user.totpSecret, Date.now()) } : {}) })
      .expect(200);
    return { ...user, token: res.body.access_token };
  }
  const stepUp = (u: SeededUser & { token: string }) => ({ password: u.password, ...(u.totpSecret ? { totp_code: totp(u.totpSecret, Date.now()) } : {}) });
  const options = (u: SeededUser & { token: string }, body: object = stepUp(u)) =>
    http().post('/v1/auth/passkeys/registration-options').set(bearer(u.token)).send(body);
  const register = (u: { token: string }, body: object, key = randomUUID()) =>
    http().post('/v1/me/passkeys').set(bearer(u.token)).set('Idempotency-Key', key).send(body);

  async function enrolled(u: SeededUser & { token: string }, opts: { multiDevice?: boolean; name?: string } = {}) {
    const challenge = (await options(u).expect(200)).body;
    const created = device.create(challenge.public_key, { multiDevice: opts.multiDevice });
    const res = await register(u, { challenge_id: challenge.challenge_id, credential: created.json, ...(opts.name ? { name: opts.name } : {}) }).expect(201);
    return { passkey: res.body, credential: created.credential, json: created.json };
  }
  async function signIn(assertion: (o: { challenge: string; rpId?: string }) => object, status: number) {
    const o = (await http().post('/v1/auth/passkeys/login-options').expect(200)).body;
    return http().post('/v1/auth/passkeys/login').send({ challenge_id: o.challenge_id, credential: assertion(o.public_key) }).expect(status);
  }

  it('registration needs the password again (and TOTP when enabled); the options name the RP from the environment', async () => {
    const u = await signedIn({ totp: true });
    expect((await options(u, { password: 'not the password' }).expect(401)).body.code).toBe('unauthorized');
    expect((await options(u, { password: u.password }).expect(401)).body.code).toBe('totp_required');
    const res = await options(u).expect(200);
    expect(valid('PasskeyChallenge', res.body)).toEqual([]);
    const pk = res.body.public_key;
    expect(pk).toMatchObject({
      rp: { id: RP_ID },
      user: { id: userHandle(u.id).toString('base64url'), name: u.email },
      attestation: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: [],
    });
    expect(pk.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-8, -7, -257]);
    // التحدي ببصمته وحدها
    const { rows } = await h.pool.query(`SELECT purpose, user_id, challenge_hash FROM webauthn_challenges WHERE id = $1`, [res.body.challenge_id]);
    expect(rows).toEqual([{ purpose: 'registration', user_id: u.id, challenge_hash: createHash('sha256').update(pk.challenge).digest() }]);
  });

  it('registers a passkey once per challenge, with the event and audit by internal id only and an alert to the owner', async () => {
    const u = await signedIn();
    const challenge = (await options(u).expect(200)).body;
    const created = device.create(challenge.public_key);
    const key = randomUUID();
    const body = { challenge_id: challenge.challenge_id, credential: created.json, name: 'هاتف العمل' };
    const res = await register(u, body, key).expect(201);
    expect(valid('Passkey', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ name: 'هاتف العمل', multi_device: true, last_used_at: null });
    // التكرار بالمفتاح نفسه يعيد الرد الأول، والتحدي لا يُستعمل لتسجيل ثانٍ
    const replay = await register(u, body, key).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(res.body);
    expect((await register(u, { challenge_id: challenge.challenge_id, credential: device.create(challenge.public_key).json }).expect(410)).body.code).toBe(
      'challenge_expired',
    );

    const { rows: stored } = await h.pool.query(`SELECT credential_id, multi_device, backed_up, transports FROM passkeys WHERE id = $1`, [res.body.id]);
    expect(stored).toEqual([{ credential_id: created.credential.id, multi_device: true, backed_up: true, transports: ['internal', 'hybrid'] }]);
    const { rows: audits } = await h.pool.query(`SELECT action, details FROM audit_log WHERE target_id = $1 AND action LIKE 'auth.passkey%'`, [u.id]);
    expect(audits).toEqual([{ action: 'auth.passkey_added', details: { target_user_id: u.id, passkey_id: res.body.id } }]);
    const { rows: events } = await h.pool.query(`SELECT payload FROM outbox_events WHERE idempotency_key = $1`, [`auth.passkey_added:${res.body.id}`]);
    expect(events).toEqual([{ payload: { passkey_id: res.body.id } }]);
    // لا تحدٍّ ولا معرّف اعتماد في أي جدول خارج passkeys، ولا اسم المفتاح في التدقيق والأحداث والإشعارات (الرد المحفوظ لمنع
    // التكرار يحمل الاسم كما يحمله الرد نفسه لصاحبه)
    await drainOutbox(h);
    for (const table of ['audit_log', 'outbox_events', 'idempotency_keys', 'webauthn_challenges', 'notifications']) {
      const { rows } = await h.pool.query(`SELECT t::text AS row FROM ${table} t`);
      const secrets = [challenge.public_key.challenge, created.json.id, ...(table === 'idempotency_keys' ? [] : ['هاتف العمل'])];
      for (const s of secrets) expect(rows.filter((r) => r.row.includes(s))).toEqual([]);
    }
    const { rows: alert } = await h.pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND type = 'auth.passkey_added'`, [u.id]);
    expect(alert).toHaveLength(1);
    // المفتاح المسجَّل مستثنى في خيارات التسجيل التالية
    const next = (await options(u).expect(200)).body.public_key;
    expect(next.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([created.json.id]);
  });

  it('refuses a response from another origin, without user verification, for another type, or to another user’s challenge', async () => {
    const u = await signedIn();
    const other = await signedIn();
    const cases: Array<[object, number]> = [
      [{ origin: 'http://localhost:4000' }, 422],
      [{ userVerified: false }, 422],
      [{ type: 'webauthn.get' }, 422],
    ];
    for (const [opts, status] of cases) {
      const c = (await options(u).expect(200)).body;
      const res = await register(u, { challenge_id: c.challenge_id, credential: device.create(c.public_key, opts).json }).expect(status);
      expect(res.body.code).toBe('validation_failed');
    }
    const c = (await options(u).expect(200)).body;
    await register(other, { challenge_id: c.challenge_id, credential: device.create(c.public_key).json }).expect(410);
    // غيره لا يستهلك تحدي المستخدم، والرد الفاشل يستهلكه
    await register(u, { challenge_id: c.challenge_id, credential: device.create(c.public_key).json }).expect(201);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1`, [u.id])).rows[0].n).toBe(1);
    const failed = (await options(u).expect(200)).body;
    await register(u, { challenge_id: failed.challenge_id, credential: device.create(failed.public_key, { userVerified: false }).json }).expect(422);
    await register(u, { challenge_id: failed.challenge_id, credential: device.create(failed.public_key).json }).expect(410);
  });

  it('a second registration of the same credential is 409 passkey_exists', async () => {
    const u = await signedIn();
    const { credential } = await enrolled(u);
    const c = (await options(u).expect(200)).body;
    const res = await register(u, { challenge_id: c.challenge_id, credential: device.create(c.public_key, { id: credential.id }).json }).expect(409);
    expect(res.body.code).toBe('passkey_exists');
  });

  it('signs in without a password or TOTP, updates the counter, and refuses replays, strangers and wrong handles', async () => {
    const u = await signedIn({ totp: true });
    const { passkey, credential } = await enrolled(u, { multiDevice: false });
    const ok = await signIn((o) => device.get(credential, o), 200);
    expect(valid('Session', ok.body)).toEqual([]);
    expect(ok.body.user_id).toBe(u.id);
    await http().get('/v1/auth/me').set(bearer(ok.body.access_token)).expect(200);
    const { rows } = await h.pool.query(`SELECT sign_count::int AS sign_count, last_used_at IS NOT NULL AS used FROM passkeys WHERE id = $1`, [passkey.id]);
    expect(rows[0]).toEqual({ sign_count: 1, used: true });

    // التحدي لمرة واحدة
    const o = (await http().post('/v1/auth/passkeys/login-options').expect(200)).body;
    const assertion = device.get(credential, o.public_key);
    await http().post('/v1/auth/passkeys/login').send({ challenge_id: o.challenge_id, credential: assertion }).expect(200);
    expect((await http().post('/v1/auth/passkeys/login').send({ challenge_id: o.challenge_id, credential: assertion }).expect(410)).body.code).toBe('challenge_expired');
    // عدّاد تراجع (نسخة من المفتاح)، ومعرّف مستخدم آخر، ومفتاح مجهول، وتوقيع على مصدر آخر: 401 واحد
    const refusals = [
      (o2: { challenge: string }) => device.get(credential, o2, { counter: 1 }),
      (o2: { challenge: string }) => device.get(credential, o2, { userHandle: userHandle(randomUUID()).toString('base64url') }),
      (o2: { challenge: string }) => device.get({ ...credential, id: randomBytes(32) }, o2),
      (o2: { challenge: string }) => device.get(credential, o2, { origin: 'http://localhost:4000' }),
      (o2: { challenge: string }) => device.get(credential, o2, { userVerified: false }),
      (o2: { challenge: string }) => device.get(credential, o2, { rpId: 'other.localhost' }),
    ];
    for (const make of refusals) {
      const res = await signIn(make, 401);
      expect(res.body).toMatchObject({ code: 'unauthorized', message: 'Authentication required.' });
    }
    // مفتاح متزامن عدّاده صفر دائمًا
    const synced = await enrolled(u, { multiDevice: true });
    await signIn((o2) => device.get(synced.credential, o2), 200);
    await signIn((o2) => device.get(synced.credential, o2), 200);
  });

  it('a suspended account or one in mandatory reset does not sign in with its passkey', async () => {
    const u = await signedIn();
    const { credential } = await enrolled(u);
    await h.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [u.id]);
    await signIn((o) => device.get(credential, o), 401);
    await h.pool.query(`UPDATE users SET status = 'active', credential_reset_required = true WHERE id = $1`, [u.id]);
    await signIn((o) => device.get(credential, o), 401);
  });

  it('lists the caller’s passkeys and revokes one; a revoked passkey no longer signs in', async () => {
    const u = await signedIn();
    const other = await signedIn();
    const first = await enrolled(u, { name: 'مفتاح الأمان' });
    const second = await enrolled(u);
    const list = await http().get('/v1/me/passkeys').set(bearer(u.token)).expect(200);
    expect(valid('PasskeyList', list.body)).toEqual([]);
    expect(list.body.items.map((p: { id: string }) => p.id)).toEqual([second.passkey.id, first.passkey.id]);
    expect((await http().get('/v1/me/passkeys').set(bearer(other.token)).expect(200)).body.items).toEqual([]);

    await http().delete(`/v1/me/passkeys/${first.passkey.id}`).set(bearer(other.token)).set('Idempotency-Key', randomUUID()).expect(404);
    await http().delete(`/v1/me/passkeys/${first.passkey.id}`).set(bearer(u.token)).set('Idempotency-Key', randomUUID()).expect(204);
    await http().delete(`/v1/me/passkeys/${first.passkey.id}`).set(bearer(u.token)).set('Idempotency-Key', randomUUID()).expect(404);
    await http().delete(`/v1/me/passkeys/not-a-uuid`).set(bearer(u.token)).set('Idempotency-Key', randomUUID()).expect(404);
    expect((await http().get('/v1/me/passkeys').set(bearer(u.token)).expect(200)).body.items.map((p: { id: string }) => p.id)).toEqual([second.passkey.id]);
    await signIn((o) => device.get(first.credential, o), 401);
    await signIn((o) => device.get(second.credential, o), 200);
    const { rows } = await h.pool.query(`SELECT payload FROM outbox_events WHERE idempotency_key = $1`, [`auth.passkey_revoked:${first.passkey.id}`]);
    expect(rows).toEqual([{ payload: { passkey_id: first.passkey.id } }]);
    const { rows: rev } = await h.pool.query(`SELECT revoked_reason FROM passkeys WHERE id = $1`, [first.passkey.id]);
    expect(rev).toEqual([{ revoked_reason: 'owner' }]);
  });

  it('an account holds at most ten passkeys', async () => {
    const u = await signedIn();
    for (let i = 0; i < 10; i++) {
      await h.pool.query(
        `INSERT INTO passkeys (user_id, credential_id, public_key, multi_device, backed_up) VALUES ($1, $2, '\\x01', false, false)`,
        [u.id, randomBytes(32)],
      );
    }
    expect((await options(u).expect(409)).body.code).toBe('passkey_limit_reached');
  });

  it('a restricted session after recovery cannot add a passkey; failed re-checks are rate-limited per account', async () => {
    const u = await signedIn();
    // جلسة ما بعد إكمال الاستعادة وقبل تأكيد TOTP: طلب مكتمل ومهلته مفتوحة
    await h.pool.query(`UPDATE users SET credential_reset_required = true WHERE id = $1`, [u.id]);
    await h.pool.query(
      `INSERT INTO recovery_requests (user_id, state, approved_by, verification_note, decided_at, expires_at, reset_token_hash,
                                      reset_token_expires_at, completed_at)
       VALUES ($1, 'approved', $1, 'test', now(), now() + interval '1 hour', $2, now() + interval '1 hour', now())`,
      [u.id, randomBytes(32)],
    );
    expect((await options(u).expect(403)).body.code).toBe('credential_reset_required');
    await h.pool.query(`UPDATE users SET credential_reset_required = false WHERE id = $1`, [u.id]);
    for (let i = 0; i < 5; i++) await options(u, { password: 'wrong password!' }).expect(401);
    const limited = await options(u).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('passkeys disabled (no WEBAUTHN_RP_ID)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  it('every passkey operation is 404', async () => {
    const http = () => request(h.app.getHttpServer());
    const user = await seedUser(h, { roles: [{ role: 'editor_in_chief' }] });
    const token = (await http().post('/v1/auth/login').send({ email: user.email, password: user.password }).expect(200)).body.access_token;
    await http().post('/v1/auth/passkeys/login-options').expect(404);
    await http()
      .post('/v1/auth/passkeys/login')
      .send({ challenge_id: randomUUID(), credential: { id: 'AA', rawId: 'AA', type: 'public-key', response: {} } })
      .expect(404);
    await http().post('/v1/auth/passkeys/registration-options').set('Authorization', `Bearer ${token}`).send({ password: user.password }).expect(404);
    await http()
      .post('/v1/me/passkeys')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ challenge_id: randomUUID(), credential: { id: 'AA', rawId: 'AA', type: 'public-key', response: {} } })
      .expect(404);
  });
});
