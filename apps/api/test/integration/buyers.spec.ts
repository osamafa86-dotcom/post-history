import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// مؤسسات المشترين وأعضاؤها (العقد v0.3، الجزء 3): الدعوة برمز تعيين لمرة واحدة، والمقاعد، وآخر مدير، وعزل المؤسسات
describe('buyer organizations (/v1/buyer-organizations)', () => {
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
  const org = (over: Record<string, unknown> = {}) => ({
    legal_name: 'Example Media LLC',
    display_name: { ar: 'مثال', en: 'Example' },
    country: 'JO',
    billing_email: 'billing@example.test',
    first_admin_email: `admin-${randomUUID()}@example.test`,
    ...over,
  });
  // حساب مشترٍ جاهز للدخول، مرتبط بمؤسسته ودوره بنطاقها (كما يتركه إكمال الدعوة)
  const buyer = async (orgId: string, role: 'buyer_admin' | 'buyer_member') => {
    const email = `buyer-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { rows } = await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id`, [
      email,
      await hash(password),
      orgId,
    ]);
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, $2, 'organization', $3)`, [rows[0]!.id, role, orgId]);
    const res = await http().post('/v1/auth/login').send({ email, password }).expect(200);
    return { id: rows[0]!.id, token: res.body.access_token as string };
  };
  const created = async (over: Record<string, unknown> = {}) => (await write('post', admin.token, '/buyer-organizations', org(over)).expect(201)).body;
  const activate = async (id: string) => {
    const current = await get(admin.token, `/buyer-organizations/${id}`).expect(200);
    const { id: _i, active_members: _a, verified_at: _v, created_at: _c, updated_at: _u, ...fields } = current.body;
    return write('put', admin.token, `/buyer-organizations/${id}`, { ...fields, status: 'active' }, { ifMatch: current.headers.etag }).expect(200);
  };

  it('creates a pending organization with its first admin; the invite token is returned once and completes like a recovery', async () => {
    const key = randomUUID();
    const body = org();
    const res = await write('post', admin.token, '/buyer-organizations', body, { key }).expect(201);
    const valid = schemaValidator('BuyerOrganizationCreated');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    expect(res.body).toMatchObject({ status: 'pending_verification', seats: 5, active_members: 0, verified_at: null });
    expect(res.body.invite_token).toEqual(expect.any(String));
    expect(res.headers.etag).toMatch(/^"\d+"$/);
    const replay = await write('post', admin.token, '/buyer-organizations', body, { key }).expect(201);
    expect(replay.body.id).toBe(res.body.id);
    expect(replay.body).not.toHaveProperty('invite_token');
    const { rows } = await h.pool.query(`SELECT action, details FROM audit_log WHERE action = 'buyer_organization.created' AND details->>'organization_id' = $1`, [res.body.id]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(body.first_admin_email);

    const members = (await get(admin.token, `/buyer-organizations/${res.body.id}/members`).expect(200)).body.items;
    expect(members).toEqual([expect.objectContaining({ email: body.first_admin_email, role: 'buyer_admin', status: 'invited', totp_enabled: false })]);
    await http().post('/v1/auth/recovery/complete').send({ reset_token: res.body.invite_token, new_password: 'a long enough passphrase 1' }).expect(200);
  });

  it('isolates tenants: a buyer reads its own organization only, any other is 404; staff routes are 403', async () => {
    const a = await created();
    const b = await created();
    const member = await buyer(a.id, 'buyer_member');
    expect((await get(member.token, `/buyer-organizations/${a.id}`).expect(200)).body.id).toBe(a.id);
    await get(member.token, `/buyer-organizations/${b.id}`).expect(404);
    await get(member.token, `/buyer-organizations/${randomUUID()}`).expect(404);
    await get(member.token, '/buyer-organizations').expect(403);
    await get(member.token, `/buyer-organizations/${a.id}/members`).expect(403);
    await get(member.token, '/materials').expect(403);
    const me = (await get(member.token, '/auth/me').expect(200)).body;
    expect(me).toMatchObject({ organization_id: a.id, roles: [{ name: 'buyer_member', scopes: [{ kind: 'organization', id: a.id }] }] });
    const page = (await get(finance.token, '/buyer-organizations?status=pending_verification&limit=1').expect(200)).body;
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toEqual(expect.any(String));
  });

  it('the buyer admin edits the profile but not the status or seats (403); the system admin activates; a stale If-Match is 412', async () => {
    const o = await created();
    const owner = await buyer(o.id, 'buyer_admin');
    const current = await get(owner.token, `/buyer-organizations/${o.id}`).expect(200);
    const { id: _i, active_members: _a, verified_at: _v, created_at: _c, updated_at: _u, ...fields } = current.body;
    const edited = await write('put', owner.token, `/buyer-organizations/${o.id}`, { ...fields, legal_name: 'Renamed LLC' }, { ifMatch: current.headers.etag }).expect(200);
    expect(edited.body.legal_name).toBe('Renamed LLC');
    await write('put', owner.token, `/buyer-organizations/${o.id}`, { ...fields, legal_name: 'x' }, { ifMatch: current.headers.etag }).expect(412);
    expect((await write('put', owner.token, `/buyer-organizations/${o.id}`, { ...fields, status: 'active' }).expect(403)).body.code).toBe('forbidden_role');
    expect((await write('put', owner.token, `/buyer-organizations/${o.id}`, { ...fields, seats: 50 }).expect(403)).body.code).toBe('forbidden_role');
    const active = await activate(o.id);
    expect(active.body).toMatchObject({ status: 'active', verified_at: expect.any(String) });
  });

  it('invites within the seats only (409 seats_exhausted), refuses a taken email (409), and keeps one active admin (409 last_buyer_admin)', async () => {
    const o = await created({ seats: 2 });
    const owner = await buyer(o.id, 'buyer_admin');
    // المدير الأول المدعو والمالك يشغلان المقعدين
    expect((await write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email: `m-${randomUUID()}@example.test`, role: 'buyer_member' }).expect(409)).body.code).toBe(
      'seats_exhausted',
    );
    const first = (await get(owner.token, `/buyer-organizations/${o.id}/members`).expect(200)).body.items.find((m: { user_id: string }) => m.user_id !== owner.id);
    await write('put', owner.token, `/buyer-organizations/${o.id}/members/${first.user_id}`, { role: 'buyer_member', status: 'suspended' }).expect(200);
    const invited = await write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email: `m-${randomUUID()}@example.test`, role: 'buyer_member' }).expect(201);
    const valid = schemaValidator('BuyerMemberCreated');
    expect(valid(invited.body) ? [] : valid.errors).toEqual([]);
    expect(invited.body).toMatchObject({ role: 'buyer_member', status: 'invited', invite_token: expect.any(String) });
    // إعادة تفعيل المعلّق تتجاوز المقاعد
    expect((await write('put', owner.token, `/buyer-organizations/${o.id}/members/${first.user_id}`, { role: 'buyer_member', status: 'active' }).expect(409)).body.code).toBe('seats_exhausted');

    const other = await created();
    await write('post', admin.token, `/buyer-organizations/${other.id}/members`, { email: admin.email, role: 'buyer_member' }).expect(409);

    await activate(o.id);
    expect((await write('put', owner.token, `/buyer-organizations/${o.id}/members/${owner.id}`, { role: 'buyer_member', status: 'active' }).expect(409)).body.code).toBe('last_buyer_admin');
    expect((await write('put', admin.token, `/buyer-organizations/${o.id}/members/${owner.id}`, { role: 'buyer_admin', status: 'suspended' }).expect(409)).body.code).toBe('last_buyer_admin');
    // عضو مؤسسة أخرى أو معرّف مجهول 404
    await write('put', owner.token, `/buyer-organizations/${o.id}/members/${randomUUID()}`, { role: 'buyer_member', status: 'active' }).expect(404);
    await write('post', owner.token, `/buyer-organizations/${other.id}/members`, { email: `x-${randomUUID()}@example.test`, role: 'buyer_member' }).expect(404);
  });
});
