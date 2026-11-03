import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// أدوار حساب الطاقم من A1 (ADR 0104): استبدال كامل بتدقيق وحدث بمعرّفات، وsystem_admin بإجراء الشخصين وحده
describe('staff roles (/v1/users/{id}/roles)', () => {
  let h: Harness;
  let admin: Actor;
  let office: string;
  const governorate = `محافظة-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    h = await createHarness();
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', $1) RETURNING id`, [governorate])).rows[0]!.id;
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const read = (a: Actor, id: string) => http().get(`/v1/users/${id}/roles`).set('Authorization', `Bearer ${a.token}`);
  const put = (a: Actor, id: string, roles: object[], key: string = randomUUID()) =>
    http().put(`/v1/users/${id}/roles`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send({ roles });
  const eventsOf = async (id: string) =>
    (await h.pool.query(`SELECT type, aggregate_type, actor_id, payload FROM outbox_events WHERE type = 'user.roles_changed' AND aggregate_id = $1 ORDER BY id`, [id])).rows;
  const auditOf = async (id: string) =>
    (await h.pool.query(`SELECT actor_id, details FROM audit_log WHERE action = 'user.roles_changed' AND target_id = $1 ORDER BY id`, [id])).rows;

  it('replaces the roles with scopes; the same list again writes nothing; ids-only event and coded audit', async () => {
    const target = await seedUser(h, { roles: [{ role: 'reporter' }] });
    const valid = schemaValidator('StaffRoles');
    const before = await read(admin, target.id).expect(200);
    expect(before.body).toEqual({ user_id: target.id, roles: [{ name: 'reporter', scopes: [] }] });
    expect(valid(before.body) ? [] : valid.errors).toEqual([]);

    const roles = [
      { name: 'supervisor', scopes: [{ kind: 'office', id: office }, { kind: 'governorate', id: governorate }] },
      { name: 'producer', scopes: [] },
    ];
    const key = randomUUID();
    const res = await put(admin, target.id, roles, key).expect(200);
    expect(res.body.user_id).toBe(target.id);
    expect(res.body.roles).toEqual([
      { name: 'producer', scopes: [] },
      { name: 'supervisor', scopes: expect.arrayContaining([{ kind: 'office', id: office }, { kind: 'governorate', id: governorate }]) },
    ]);
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    // التكرار بالمفتاح نفسه، والقائمة نفسها بمفتاح جديد، لا يكتبان شيئًا
    await put(admin, target.id, roles, key).expect(200);
    await put(admin, target.id, [...roles].reverse()).expect(200);
    expect(await eventsOf(target.id)).toEqual([{ type: 'user.roles_changed', aggregate_type: 'user', actor_id: admin.id, payload: { user_id: target.id } }]);
    expect(await auditOf(target.id)).toEqual([
      {
        actor_id: admin.id,
        details: { target_user_id: target.id, from: ['reporter'], to: ['producer', `supervisor:governorate:${governorate}`, `supervisor:office:${office}`] },
      },
    ]);
    const stored = await h.pool.query(`SELECT role, scope_kind, scope_id, granted_by FROM user_roles WHERE user_id = $1 ORDER BY role, scope_kind`, [target.id]);
    expect(stored.rows).toEqual([
      { role: 'producer', scope_kind: 'all', scope_id: '', granted_by: admin.id },
      { role: 'supervisor', scope_kind: 'governorate', scope_id: governorate, granted_by: admin.id },
      { role: 'supervisor', scope_kind: 'office', scope_id: office, granted_by: admin.id },
    ]);
  });

  it('applies on the next request of the changed account', async () => {
    const target = await loginAs(h, [{ role: 'reporter' }]);
    await http().get('/v1/assignment-candidates').set('Authorization', `Bearer ${target.token}`).expect(403);
    await put(admin, target.id, [{ name: 'editor_in_chief', scopes: [] }]).expect(200);
    await http().get('/v1/assignment-candidates').set('Authorization', `Bearer ${target.token}`).expect(200);
  });

  it('keeps system_admin out in both directions, so the last admin is never removed here', async () => {
    const other = await seedUser(h, { roles: [{ role: 'system_admin' }, { role: 'supervisor' }] });
    const plain = await seedUser(h, { roles: [{ role: 'producer' }] });
    // تنزيل مدير آخر أو أي تغيير لحسابه، ومنح الدور
    expect((await put(admin, other.id, [{ name: 'supervisor', scopes: [] }]).expect(403)).body.code).toBe('admin_quorum_required');
    expect((await put(admin, other.id, [{ name: 'system_admin', scopes: [] }, { name: 'producer', scopes: [] }]).expect(403)).body.code).toBe('admin_quorum_required');
    expect((await put(admin, plain.id, [{ name: 'system_admin', scopes: [] }]).expect(403)).body.code).toBe('admin_quorum_required');
    // المدير لا يغيّر أدواره، ولو كان آخر مدير فاعل
    expect((await put(admin, admin.id, [{ name: 'producer', scopes: [] }]).expect(403)).body.code).toBe('forbidden_scope');
    const admins = await h.pool.query(`SELECT user_id FROM user_roles WHERE role = 'system_admin' AND user_id = ANY($1)`, [[admin.id, other.id]]);
    expect(admins.rows).toHaveLength(2);
    expect(await eventsOf(other.id)).toEqual([]);
    expect(await eventsOf(plain.id)).toEqual([]);
  });

  it('refuses buyer roles, scopes outside the supervisor, unknown offices and governorates, and duplicates (422)', async () => {
    const target = await seedUser(h, { roles: [{ role: 'reporter' }] });
    const refused = async (roles: object[], field: string) => {
      const res = await put(admin, target.id, roles).expect(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details.fields).toContain(field);
    };
    await refused([{ name: 'buyer_admin', scopes: [] }], '/roles/0/name');
    await refused([{ name: 'producer', scopes: [{ kind: 'office', id: office }] }], '/roles/0/scopes');
    await refused([{ name: 'supervisor', scopes: [{ kind: 'organization', id: randomUUID() }] }], '/roles/0/scopes/0');
    await refused([{ name: 'supervisor', scopes: [{ kind: 'office', id: randomUUID() }] }], '/roles/0/scopes/0/id');
    await refused([{ name: 'supervisor', scopes: [{ kind: 'governorate', id: 'محافظة غير موجودة' }] }], '/roles/0/scopes/0/id');
    await refused([{ name: 'producer', scopes: [] }, { name: 'producer', scopes: [] }], '/roles/1/name');
    await put(admin, target.id, []).expect(422);
    expect(await eventsOf(target.id)).toEqual([]);
  });

  it('is for the system admin on staff accounts only: other roles 403, buyer and unknown accounts 404', async () => {
    const chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    const target = await seedUser(h, { roles: [{ role: 'reporter' }] });
    expect((await read(chief, target.id).expect(403)).body.code).toBe('forbidden_role');
    expect((await put(chief, target.id, [{ name: 'producer', scopes: [] }]).expect(403)).body.code).toBe('forbidden_role');
    const org = (await h.pool.query<{ id: string }>(
      `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email)
       VALUES ('Sample Media Ltd', 'م', 'Sample', 'GB', 'billing@example.test') RETURNING id`)).rows[0]!.id;
    const buyer = (await h.pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, organization_id) VALUES ($1, 'argon2id$test', $2) RETURNING id`, [`b-${randomUUID()}@example.test`, org])).rows[0]!.id;
    await read(admin, buyer).expect(404);
    await put(admin, buyer, [{ name: 'producer', scopes: [] }]).expect(404);
    await read(admin, randomUUID()).expect(404);
    await read(admin, 'nope').expect(404);
  });
});
