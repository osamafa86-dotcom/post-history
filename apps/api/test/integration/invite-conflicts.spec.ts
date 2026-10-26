import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { totp } from '../../src/common/crypto';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

// طابور تعارض دعوات المشترين لمدير النظام (العقد #361، فوق #331 و#332): القائمة، والحسم بالحالة وبرمز TOTP حاضر
describe('buyer invite conflicts (/v1/buyer-invite-conflicts)', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof seedUser>> & { token: string };
  beforeAll(async () => {
    h = await createHarness();
    const u = await seedUser(h, { totp: true, roles: [{ role: 'system_admin' }] });
    const res = await request(h.app.getHttpServer()).post('/v1/auth/login').send({ email: u.email, password: u.password, totp_code: totp(u.totpSecret!, Date.now()) }).expect(200);
    admin = { ...u, token: res.body.access_token };
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const code = () => totp(admin.totpSecret!, Date.now());
  const resolve = (id: string, body: object, t = admin.token) => http().post(`/v1/buyer-invite-conflicts/${id}/resolve`).set(as(t)).set('Idempotency-Key', randomUUID()).send(body);
  // مؤسسة بمديرها، ودعوة ببريد حساب قائم خارجها، فيصير تعارضًا
  const conflicted = async () => {
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email, status, verified_at, verified_by)
       VALUES ('Buyer LLC', 'مشترٍ', 'Buyer', 'JO', 'b@example.test', 'active', now(), gen_random_uuid()) RETURNING id`,
    );
    const orgId = rows[0]!.id;
    const email = `owner-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { rows: u } = await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id`, [email, await hash(password), orgId]);
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, 'buyer_admin', 'organization', $2)`, [u[0]!.id, orgId]);
    const owner = (await http().post('/v1/auth/login').send({ email, password }).expect(200)).body.access_token as string;
    const existing = await seedUser(h, { roles: [{ role: 'reporter' }] });
    const invited = await http().post(`/v1/buyer-organizations/${orgId}/members`).set(as(owner)).set('Idempotency-Key', randomUUID()).send({ email: existing.email, role: 'buyer_member' }).expect(201);
    return { orgId, owner, existing, conflictId: invited.body.user_id as string };
  };

  it('lists the conflicts oldest first, filtered by state, in the contract shape; system admin only', async () => {
    const a = await conflicted();
    const b = await conflicted();
    const page = (await http().get('/v1/buyer-invite-conflicts?state=pending&limit=100').set(as(admin.token)).expect(200)).body;
    const valid = schemaValidator('BuyerInviteConflictPage');
    expect(valid(page) ? [] : valid.errors).toEqual([]);
    const ids = page.items.map((c: { id: string }) => c.id);
    expect(ids.indexOf(a.conflictId)).toBeLessThan(ids.indexOf(b.conflictId));
    expect(page.items.find((c: { id: string }) => c.id === a.conflictId)).toMatchObject({ organization_id: a.orgId, existing_user_id: a.existing.id, role: 'buyer_member', state: 'pending', resolved_at: null });
    // التصفح بالمؤشر بلا فجوة
    const first = (await http().get('/v1/buyer-invite-conflicts?limit=1').set(as(admin.token)).expect(200)).body;
    const second = (await http().get(`/v1/buyer-invite-conflicts?limit=1&cursor=${first.next_cursor}`).set(as(admin.token)).expect(200)).body;
    expect(second.items[0].id).not.toBe(first.items[0].id);
    await http().get('/v1/buyer-invite-conflicts?cursor=x').set(as(admin.token)).expect(400);

    const finance = await loginAs(h, [{ role: 'finance' }]);
    expect((await http().get('/v1/buyer-invite-conflicts').set(as(finance.token)).expect(403)).body.code).toBe('forbidden_role');
    expect((await http().get('/v1/buyer-invite-conflicts').set(as(a.owner)).expect(403)).body.code).toBe('forbidden_role');
    expect((await resolve(a.conflictId, { state: 'dismissed', totp_code: '000000' }, a.owner).expect(403)).body.code).toBe('forbidden_role');
  });

  it('resolves by state with a present TOTP code: pending to suspended to dismissed, nothing after; unknown 404', async () => {
    const c = await conflicted();
    expect((await resolve(c.conflictId, { state: 'suspended', totp_code: '000000' }).expect(401)).body.code).toBe('totp_required');
    await resolve(c.conflictId, { state: 'suspended' }).expect(422);
    await resolve(c.conflictId, { state: 'pending', totp_code: code() }).expect(422);
    await resolve(c.conflictId, { state: 'dismissed', totp_code: code(), note: 'free text' }).expect(422);
    await resolve(randomUUID(), { state: 'dismissed', totp_code: code() }).expect(404);

    const suspended = await resolve(c.conflictId, { state: 'suspended', totp_code: code() }).expect(200);
    const valid = schemaValidator('BuyerInviteConflict');
    expect(valid(suspended.body) ? [] : valid.errors).toEqual([]);
    expect(suspended.body).toMatchObject({ state: 'suspended', resolved_at: null, resolved_by: null });
    // المؤسسة ترى عضوها المدعو البديل معلّقًا
    const member = (await http().get(`/v1/buyer-organizations/${c.orgId}/members`).set(as(c.owner)).expect(200)).body.items.find((m: { user_id: string }) => m.user_id === c.conflictId);
    expect(member.status).toBe('suspended');
    expect((await resolve(c.conflictId, { state: 'suspended', totp_code: code() }).expect(409)).body.code).toBe('invalid_transition');

    const dismissed = await resolve(c.conflictId, { state: 'dismissed', totp_code: code() }).expect(200);
    expect(dismissed.body).toMatchObject({ state: 'dismissed', resolved_by: admin.id, resolved_at: expect.any(String) });
    expect((await resolve(c.conflictId, { state: 'dismissed', totp_code: code() }).expect(409)).body.code).toBe('invalid_transition');
    // خرج من قائمة المؤسسة ومقاعدها، والتدقيق بـ conflict_id بلا البريد
    const members = (await http().get(`/v1/buyer-organizations/${c.orgId}/members`).set(as(c.owner)).expect(200)).body.items;
    expect(members.map((m: { user_id: string }) => m.user_id)).not.toContain(c.conflictId);
    const { rows } = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'buyer_member.invite_conflict_resolved' AND details->>'conflict_id' = $1 ORDER BY id`, [c.conflictId]);
    expect(rows.map((r) => r.details.to)).toEqual(['suspended', 'dismissed']);
    expect(JSON.stringify(rows)).not.toContain(c.existing.email.toLowerCase());
  });
});
