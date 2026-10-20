import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

describe('account status (PUT /users/{id}/status)', () => {
  let h: Harness;
  let admin: Actor;
  beforeAll(async () => {
    h = await createHarness();
    admin = await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const setStatus = (a: Actor, id: string, body: object, key = randomUUID()) =>
    http().put(`/v1/users/${id}/status`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body);
  const audits = async (id: string) =>
    (await h.pool.query(`SELECT actor_id, action, details FROM audit_log WHERE target_id = $1 AND action LIKE 'user.%' ORDER BY id`, [id])).rows;
  const login = (u: Actor) => http().post('/v1/auth/login').send({ email: u.email, password: u.password });

  it('suspension revokes every session and upload token at once; repeating it changes nothing', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const upload = await seedUploadSession(h, reporter.id);
    await setStatus(admin, reporter.id, { status: 'suspended' }).expect(204);

    await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(401);
    await login(reporter).expect(401);
    const { rows } = await h.pool.query(`SELECT upload_token_hash, upload_token_expires_at FROM upload_sessions WHERE id = $1`, [upload.id]);
    expect(rows[0]).toEqual({ upload_token_hash: null, upload_token_expires_at: null });

    await setStatus(admin, reporter.id, { status: 'suspended' }).expect(204);
    // التدقيق بـ reason_code وحده، مرة واحدة
    expect(await audits(reporter.id)).toEqual([
      { actor_id: admin.id, action: 'user.suspended', details: { target_user_id: reporter.id, reason_code: 'suspended' } },
    ]);
  });

  it('reactivation lets the user log in again but restores no session', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    await setStatus(admin, reporter.id, { status: 'suspended' }).expect(204);
    await setStatus(admin, reporter.id, { status: 'active' }).expect(204);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(401);
    await login(reporter).expect(200);
    expect((await audits(reporter.id)).map((a) => [a.action, a.details.reason_code])).toEqual([
      ['user.suspended', 'suspended'],
      ['user.reactivated', 'reactivated'],
    ]);
  });

  it('a system administrator account is never changed here, the caller included', async () => {
    const otherAdmin = await loginAs(h, [{ role: 'system_admin' }]);
    for (const status of ['suspended', 'active']) {
      expect((await setStatus(admin, otherAdmin.id, { status }).expect(403)).body.code).toBe('admin_quorum_required');
    }
    expect((await setStatus(admin, admin.id, { status: 'suspended' }).expect(403)).body.code).toBe('forbidden_scope');
    const { rows } = await h.pool.query(`SELECT status FROM users WHERE id = ANY($1)`, [[admin.id, otherAdmin.id]]);
    expect(rows.every((r) => r.status === 'active')).toBe(true);
    expect(await audits(otherAdmin.id)).toEqual([]);
  });

  it('only a system administrator; unknown ids are 404; the body and the key are validated', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'all', scopeId: '' }]);
    expect((await setStatus(supervisor, reporter.id, { status: 'suspended' }).expect(403)).body.code).toBe('forbidden_role');
    await setStatus(admin, randomUUID(), { status: 'suspended' }).expect(404);
    await setStatus(admin, 'not-a-uuid', { status: 'suspended' }).expect(404);
    await setStatus(admin, reporter.id, { status: 'deleted' }).expect(422);
    await setStatus(admin, reporter.id, {}).expect(422);
    await http()
      .put(`/v1/users/${reporter.id}/status`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ status: 'suspended' })
      .expect(422);
    await http().get('/v1/auth/me').set('Authorization', `Bearer ${reporter.token}`).expect(200);
  });
});
