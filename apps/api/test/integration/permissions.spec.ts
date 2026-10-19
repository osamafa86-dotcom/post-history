import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, type Harness, loginAs } from './harness';

describe('independent permissions (/v1/users/{id}/permissions/{permission})', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.close());

  const call = (token: string, method: 'put' | 'delete', url: string, body?: object) =>
    request(h.app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const me = async (token: string) =>
    (await request(h.app.getHttpServer()).get('/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(200)).body.permissions;

  it('grants and revokes idempotently, takes effect on the next request, and is audited', async () => {
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    const user = await loginAs(h, [{ role: 'supervisor' }]);
    const url = `/v1/users/${user.id}/permissions/protected_source:read`;
    expect(await me(user.token)).toEqual([]);
    await call(admin.token, 'put', url, { reason: 'investigations desk' }).expect(204);
    await call(admin.token, 'put', url, { reason: 'again' }).expect(204);
    expect(await me(user.token)).toEqual(['protected_source:read']);
    const { rows } = await h.pool.query(
      `SELECT count(*)::int AS n FROM user_permissions WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    expect(rows[0].n).toBe(1);
    await call(admin.token, 'delete', url).expect(204);
    await call(admin.token, 'delete', url).expect(204);
    expect(await me(user.token)).toEqual([]);
    const { rows: audit } = await h.pool.query(
      `SELECT action, actor_id, details FROM audit_log WHERE target_id = $1 ORDER BY id`,
      [user.id],
    );
    expect(audit.map((a) => a.action)).toEqual(['permission.granted', 'permission.revoked']);
    expect(audit[0].actor_id).toBe(admin.id);
    expect(JSON.stringify(audit)).not.toContain('investigations desk');
  });

  it('is for system admins only; validates the user, the permission and the reason', async () => {
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    const editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    const target = await loginAs(h, [{ role: 'reporter' }]);
    await call(editor.token, 'put', `/v1/users/${target.id}/permissions/protected_source:read`, { reason: 'x' }).expect(403);
    await call(admin.token, 'put', `/v1/users/${randomUUID()}/permissions/protected_source:read`, { reason: 'x' }).expect(404);
    await call(admin.token, 'put', `/v1/users/${target.id}/permissions/everything`, { reason: 'x' }).expect(422);
    await call(admin.token, 'delete', `/v1/users/${target.id}/permissions/everything`).expect(404);
    await call(admin.token, 'put', `/v1/users/${target.id}/permissions/sensitive_location:read`, {}).expect(422);
  });
});
