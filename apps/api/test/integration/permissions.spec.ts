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

  it('history: grants, revocations and the legal-name setting changes, newest first, ids and codes only, with a cursor', async () => {
    const admin = await loginAs(h, [{ role: 'system_admin' }]);
    const user = await loginAs(h, [{ role: 'editor_in_chief' }]);
    const other = await loginAs(h, [{ role: 'editor_in_chief' }]);
    const history = (token: string, id: string, qs = '') =>
      request(h.app.getHttpServer()).get(`/v1/users/${id}/permissions/history${qs}`).set('Authorization', `Bearer ${token}`);
    await call(admin.token, 'put', `/v1/users/${user.id}/permissions/reporter_identity:read`, { reason: 'free text never returned' }).expect(204);
    await call(admin.token, 'put', `/v1/users/${other.id}/permissions/protected_source:read`, { reason: 'other user' }).expect(204);
    // تغيير الإعداد كما يكتبه الخادم (ADR 0021)؛ يظهر في سجل كل مستخدم
    await h.pool.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, details, hash)
       VALUES ($1::uuid, 'setting.changed', 'user', $1::text, $2, '\\x00')`,
      [admin.id, { setting: 'reporter_legal_name_access', value: 'protected_source', reason_code: 'policy_change' }],
    );
    await call(admin.token, 'delete', `/v1/users/${user.id}/permissions/reporter_identity:read`).expect(204);

    const res = await history(admin.token, user.id, '?limit=100').expect(200);
    const mine = res.body.items.filter((e: { kind: string; actor_id: string }) => e.kind !== 'setting_changed' || e.actor_id === admin.id);
    expect(mine.slice(0, 3).map((e: { kind: string }) => e.kind)).toEqual(['permission_revoked', 'setting_changed', 'permission_granted']);
    expect(mine[0]).toMatchObject({ permission: 'reporter_identity:read', setting: null, value: null, actor_id: admin.id, reason_code: null });
    expect(mine[1]).toMatchObject({ permission: null, setting: 'reporter_legal_name_access', value: 'protected_source', reason_code: 'policy_change' });
    // منح مستخدم آخر لا يظهر، ولا السبب الحر
    expect(res.body.items.some((e: { permission: string | null }) => e.permission === 'protected_source:read')).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('free text');

    // المؤشر: صفحة بعنصر واحد ثم التالية حتى النهاية، بلا تكرار
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: request.Response = await history(admin.token, user.id, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
      seen.push(...page.body.items.map((e: { id: string }) => e.id));
      cursor = page.body.next_cursor;
    } while (cursor && seen.length < 500);
    expect(seen).toEqual(res.body.items.map((e: { id: string }) => e.id));
    expect(new Set(seen).size).toBe(seen.length);

    await history(admin.token, user.id, '?cursor=abc').expect(400);
    await history(admin.token, randomUUID()).expect(404);
    await history(user.token, user.id).expect(403);
  });
});
