import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// رفض طلب انضمام مؤسسة قيد التحقق بسبب مرمّز (A5، ADR 0104)، وحدث حالة المؤسسة من الرفض ومن PUT
describe('buyer organization rejection (/v1/buyer-organizations/{org_id}/rejection)', () => {
  let h: Harness;
  let admin: Actor;
  let finance: Actor;
  beforeAll(async () => {
    h = await createHarness();
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const write = (method: 'post' | 'put', t: string, url: string, body: object, extra: Record<string, string> = {}) =>
    http()[method](`/v1${url}`).set(auth(t)).set('Idempotency-Key', extra.key ?? randomUUID()).set(extra.ifMatch ? { 'If-Match': extra.ifMatch } : {}).send(body);
  const get = (t: string, url: string) => http().get(`/v1${url}`).set(auth(t));
  const created = async () =>
    (
      await write('post', admin.token, '/buyer-organizations', {
        legal_name: 'Sample Media LLC',
        display_name: { ar: 'مؤسسة تجريبية', en: 'Sample' },
        country: 'JO',
        billing_email: 'billing@example.test',
        first_admin_email: `admin-${randomUUID()}@example.test`,
      }).expect(201)
    ).body as { id: string };
  const reject = (id: string, reason = 'commercial_registry', extra: Record<string, string> = {}) =>
    write('post', admin.token, `/buyer-organizations/${id}/rejection`, { reason_code: reason }, extra);
  const putStatus = async (id: string, status: string, expected: number) => {
    const current = await get(admin.token, `/buyer-organizations/${id}`).expect(200);
    const { id: _i, active_members: _a, verified_at: _v, created_at: _c, updated_at: _u, rejection_reason: _r, ...fields } = current.body;
    return write('put', admin.token, `/buyer-organizations/${id}`, { ...fields, status }, { ifMatch: current.headers.etag }).expect(expected);
  };
  const eventsOf = async (id: string) =>
    (await h.pool.query(`SELECT aggregate_type, actor_id, payload FROM outbox_events WHERE type = 'buyer_organization.status_changed' AND aggregate_id = $1 ORDER BY id`, [id])).rows;
  const auditOf = async (id: string) =>
    (await h.pool.query(`SELECT details FROM audit_log WHERE action = 'buyer_organization.status_changed' AND details->>'organization_id' = $1 ORDER BY id`, [id])).rows.map((r) => r.details);

  it('rejects a pending organization with a coded reason, once, with an event and audit and no name', async () => {
    const org = await created();
    const before = await get(admin.token, `/buyer-organizations/${org.id}`).expect(200);
    expect(before.body.rejection_reason).toBeUndefined();
    await reject(org.id, 'commercial_registry', { ifMatch: '"0"' }).expect(412);
    const key = randomUUID();
    const res = await reject(org.id, 'commercial_registry', { key, ifMatch: before.headers.etag }).expect(200);
    expect(res.body).toMatchObject({ id: org.id, status: 'rejected', rejection_reason: 'commercial_registry', verified_at: null });
    expect(res.headers.etag).toMatch(/^"\d+"$/);
    const valid = schemaValidator('BuyerOrganization');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    // التكرار بالمفتاح نفسه يعيد الرد نفسه، وبمفتاح جديد 409
    expect((await reject(org.id, 'commercial_registry', { key }).expect(200)).body.status).toBe('rejected');
    const again = await reject(org.id, 'other').expect(409);
    expect(again.body).toMatchObject({ code: 'invalid_transition', details: { from: 'rejected', to: 'rejected' } });
    expect(await eventsOf(org.id)).toEqual([
      { aggregate_type: 'organization', actor_id: admin.id, payload: { organization_id: org.id, from: 'pending_verification', to: 'rejected', reason_code: 'commercial_registry' } },
    ]);
    expect(await auditOf(org.id)).toEqual([{ organization_id: org.id, from: 'pending_verification', to: 'rejected', reason_code: 'commercial_registry' }]);
    expect(JSON.stringify(await eventsOf(org.id))).not.toContain('Sample');
    // القائمة بالحالة الجديدة
    const listed = await get(admin.token, '/buyer-organizations?status=rejected&limit=100').expect(200);
    expect(listed.body.items.map((o: { id: string }) => o.id)).toContain(org.id);
  });

  it('refuses rejection outside pending verification, for other roles, and with an unknown reason', async () => {
    const org = await created();
    await putStatus(org.id, 'active', 200);
    expect((await reject(org.id).expect(409)).body.code).toBe('invalid_transition');
    const pending = await created();
    expect((await write('post', finance.token, `/buyer-organizations/${pending.id}/rejection`, { reason_code: 'other' }).expect(403)).body.code).toBe('forbidden_role');
    expect((await reject(pending.id, 'no_reason').expect(422)).body.code).toBe('validation_failed');
    await write('post', admin.token, `/buyer-organizations/${pending.id}/rejection`, { reason_code: 'other', note: 'نص حر' }).expect(422);
    await reject(randomUUID()).expect(404);
    // PUT لا يضع rejected
    expect((await putStatus(pending.id, 'rejected', 422)).body.code).toBe('validation_failed');
    expect((await get(admin.token, `/buyer-organizations/${pending.id}`).expect(200)).body.status).toBe('pending_verification');
  });

  it('keeps a rejected organization out of the catalog, and PUT returns it to another status clearing the reason', async () => {
    const org = await created();
    await reject(org.id, 'license_agreement').expect(200);
    const email = `buyer-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { rows } = await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id`, [email, await hash(password), org.id]);
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, 'buyer_member', 'organization', $2)`, [rows[0]!.id, org.id]);
    const member = (await http().post('/v1/auth/login').send({ email, password }).expect(200)).body.access_token as string;
    // العضو يقرأ مؤسسته وسبب رفضها، والكتالوج مغلق
    expect((await get(member, `/buyer-organizations/${org.id}`).expect(200)).body).toMatchObject({ status: 'rejected', rejection_reason: 'license_agreement' });
    expect((await get(member, '/catalog').expect(403)).body.code).toBe('forbidden_scope');

    const reopened = await putStatus(org.id, 'pending_verification', 200);
    expect(reopened.body.status).toBe('pending_verification');
    expect(reopened.body.rejection_reason).toBeUndefined();
    const active = await putStatus(org.id, 'active', 200);
    expect(active.body.status).toBe('active');
    expect((await eventsOf(org.id)).map((e) => e.payload)).toEqual([
      { organization_id: org.id, from: 'pending_verification', to: 'rejected', reason_code: 'license_agreement' },
      { organization_id: org.id, from: 'rejected', to: 'pending_verification', reason_code: null },
      { organization_id: org.id, from: 'pending_verification', to: 'active', reason_code: null },
    ]);
  });
});
