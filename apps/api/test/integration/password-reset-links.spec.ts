import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { base32Decode, totp } from '../../src/common/crypto';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, drainOutbox, freshTotp, type Harness, loginAs, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

/**
 * رابط إعادة التعيين من مدير النظام (A1، ADR 0107): لا بريد، فالمدير يرى الرمز مرة ويسلّمه بيده. قصير العمر ولمرة واحدة ومُدقَّق،
 * والحدث معرّفات وحدها، والتكرار بالمفتاح نفسه لا يعيد الرمز. الإكمال مسار الاستعادة القائم.
 */
describe('admin-issued password reset links (POST /users/{id}/password-reset-links)', () => {
  let h: Harness;
  let admin: Actor;
  let office: string;
  beforeAll(async () => {
    h = await createHarness({ env: { PASSWORD_RESET_LINK_TTL_SECONDS: '1800' } });
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'Reset office', 'gaza') RETURNING id`)).rows[0]!.id;
    admin = await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const issue = (actor: { token: string }, userId: string, body: object = { reason: 'forgot_password' }, key = randomUUID()) =>
    http().post(`/v1/users/${userId}/password-reset-links`).set(bearer(actor.token)).set('Idempotency-Key', key).send(body);
  const complete = (reset_token: string, new_password = 'a fresh passphrase for the reset') =>
    http().post('/v1/auth/recovery/complete').send({ reset_token, new_password });

  async function reporter() {
    const user = await seedUser(h, { totp: true, roles: [{ role: 'reporter' }] });
    await h.pool.query(`UPDATE users SET office_id = $2 WHERE id = $1`, [user.id, office]);
    const session = await http()
      .post('/v1/auth/login')
      .send({ email: user.email, password: user.password, totp_code: freshTotp(user.id, user.totpSecret!) })
      .expect(200);
    return { ...user, token: session.body.access_token as string };
  }

  it('issues a short-lived single-use token once; the account is reset at once and completes through the recovery path', async () => {
    const user = await reporter();
    await h.pool.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, multi_device, backed_up) VALUES ($1, $2, '\\x01', true, true)`,
      [user.id, randomBytes(32)],
    );
    const before = Date.now();
    const res = await issue(admin, user.id).expect(201);
    const valid = schemaValidator('PasswordResetLink');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    const token: string = res.body.reset_token;
    expect(token.length).toBeGreaterThanOrEqual(32);
    const ttl = Date.parse(res.body.reset_token_expires_at) - before;
    expect(ttl).toBeGreaterThan(1790_000);
    expect(ttl).toBeLessThan(1810_000);

    // كل وصول قائم يسقط، وكلمة المرور القديمة لا تدخل، ومفاتيح المرور مبطَلة بسبب إعادة التعيين
    await http().get('/v1/auth/me').set(bearer(user.token)).expect(401);
    await http().post('/v1/auth/login').send({ email: user.email, password: user.password, totp_code: totp(user.totpSecret!, Date.now()) }).expect(401);
    const { rows: keys } = await h.pool.query(`SELECT revoked_reason FROM passkeys WHERE user_id = $1`, [user.id]);
    expect(keys).toEqual([{ revoked_reason: 'credential_reset' }]);

    // الإكمال كما في الاستعادة: كلمة مرور جديدة وTOTP جديد، ثم جلسة كاملة؛ والرمز لا يُستعمل مرتين
    const done = await complete(token).expect(200);
    await complete(token).expect(401);
    const secret = base32Decode(done.body.totp_enrollment.secret_base32);
    const full = await http()
      .post('/v1/auth/totp/confirm')
      .set(bearer(done.body.session.access_token))
      .send({ totp_code: freshTotp(user.id, secret) })
      .expect(200);
    await http().get('/v1/auth/sessions').set(bearer(full.body.access_token)).expect(200);

    // التدقيق بالسبب والمعرّفات، والحدث بالمعرّفات وحدها، ولا رمز في أي منهما ولا في الرد المحفوظ لمنع التكرار
    const { rows: audits } = await h.pool.query(`SELECT actor_id, details FROM audit_log WHERE target_id = $1 AND action = 'auth.reset_link_issued'`, [user.id]);
    expect(audits).toEqual([
      {
        actor_id: admin.id,
        details: { recovery_request_id: res.body.recovery_request_id, target_user_id: user.id, reason_code: 'forgot_password', passkeys_revoked: '1' },
      },
    ]);
    const { rows: events } = await h.pool.query(`SELECT payload, actor_id FROM outbox_events WHERE idempotency_key = $1`, [
      `auth.recovery_approved:${res.body.recovery_request_id}`,
    ]);
    expect(events).toEqual([{ payload: { recovery_request_id: res.body.recovery_request_id, office_id: office }, actor_id: admin.id }]);
    await drainOutbox(h);
    for (const table of ['audit_log', 'outbox_events', 'idempotency_keys', 'notifications', 'recovery_requests']) {
      const { rows } = await h.pool.query(`SELECT t::text AS row FROM ${table} t`);
      expect(rows.filter((r) => r.row.includes(token))).toEqual([]);
    }
  });

  it('a replay with the same key returns the same answer without the token; a new link supersedes the previous one', async () => {
    const user = await reporter();
    const key = randomUUID();
    const first = await issue(admin, user.id, { reason: 'lost_device' }, key).expect(201);
    const replay = await issue(admin, user.id, { reason: 'lost_device' }, key).expect(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual({ recovery_request_id: first.body.recovery_request_id, reset_token_expires_at: first.body.reset_token_expires_at });
    expect((await issue(admin, user.id, { reason: 'suspected_compromise' }, key).expect(422)).body.code).toBe('idempotency_key_reused');

    const second = await issue(admin, user.id, { reason: 'lost_device' }).expect(201);
    await complete(first.body.reset_token).expect(401);
    await complete(second.body.reset_token).expect(200);
    const { rows } = await h.pool.query(`SELECT id, state, reset_token_hash IS NULL AS cleared FROM recovery_requests WHERE user_id = $1 ORDER BY created_at`, [
      user.id,
    ]);
    expect(rows).toEqual([
      { id: first.body.recovery_request_id, state: 'expired', cleared: true },
      { id: second.body.recovery_request_id, state: 'approved', cleared: false },
    ]);
  });

  it('closes a pending backup-code request of the same account', async () => {
    const user = await reporter();
    const pending = (
      await h.pool.query<{ id: string }>(`INSERT INTO recovery_requests (user_id, expires_at) VALUES ($1, now() + interval '1 hour') RETURNING id`, [user.id])
    ).rows[0]!.id;
    await issue(admin, user.id).expect(201);
    const { rows } = await h.pool.query(`SELECT state, decided_at IS NOT NULL AS decided FROM recovery_requests WHERE id = $1`, [pending]);
    expect(rows).toEqual([{ state: 'rejected', decided: true }]);
  });

  it('works for a buyer account too and re-sends an invitation (the invite token stops working)', async () => {
    const org = (
      await h.pool.query<{ id: string }>(
        `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email) VALUES ('B', 'م', 'B', 'JO', 'b@example.test') RETURNING id`,
      )
    ).rows[0]!.id;
    const buyer = await seedUser(h, { roles: [] });
    await h.pool.query(`UPDATE users SET organization_id = $2 WHERE id = $1`, [buyer.id, org]);
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, 'buyer_member', 'organization', $2)`, [buyer.id, org]);
    const invite = randomBytes(32).toString('base64url');
    await h.pool.query(
      `INSERT INTO recovery_requests (user_id, state, approved_by, verification_note, decided_at, expires_at, reset_token_hash, reset_token_expires_at)
       VALUES ($1, 'approved', $2, 'buyer invitation', now(), now() + interval '1 day', $3, now() + interval '1 day')`,
      [buyer.id, admin.id, createHash('sha256').update(invite).digest()],
    );
    await h.pool.query(`UPDATE users SET credential_reset_required = true WHERE id = $1`, [buyer.id]);
    const res = await issue(admin, buyer.id).expect(201);
    await complete(invite).expect(401);
    await complete(res.body.reset_token).expect(200);
  });

  it('refuses other roles, the caller’s own account, another administrator, a suspended or unknown account and an unknown reason', async () => {
    const user = await reporter();
    // مدير جديد: حد المعدل لكل مدير لا يختلط بما أصدره مدير الاختبارات السابقة
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    const sup = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    expect((await issue(sup, user.id).expect(403)).body.code).toBe('forbidden_role');
    expect((await issue(admin, admin.id).expect(403)).body.code).toBe('forbidden_scope');
    const otherAdmin = await seedUser(h, { roles: [{ role: 'system_admin' }] });
    expect((await issue(admin, otherAdmin.id).expect(403)).body.code).toBe('admin_quorum_required');
    const suspended = await seedUser(h, { status: 'suspended', roles: [{ role: 'reporter' }] });
    expect((await issue(admin, suspended.id).expect(409)).body.code).toBe('recovery_state_conflict');
    await issue(admin, randomUUID()).expect(404);
    await issue(admin, 'not-a-uuid').expect(404);
    expect((await issue(admin, user.id, { reason: 'because' }).expect(422)).body.code).toBe('validation_failed');
    expect((await issue(admin, user.id, { reason: 'forgot_password', note: 'free text' }).expect(422)).body.code).toBe('validation_failed');
    // لا أثر لأي رفض: الحساب على حاله
    await http().get('/v1/auth/me').set(bearer(user.token)).expect(200);
  });

  it('is rate-limited per administrator', async () => {
    const busy = await loginAs(h, [{ role: 'system_admin' }]);
    for (let i = 0; i < 5; i++) {
      const target = await seedUser(h, { roles: [{ role: 'reporter' }] });
      await issue(busy, target.id).expect(201);
    }
    const target = await seedUser(h, { roles: [{ role: 'reporter' }] });
    const limited = await issue(busy, target.id).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
