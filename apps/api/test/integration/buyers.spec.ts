import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { dismissInviteConflict, openInviteConflicts } from '../../src/commerce/invite-conflicts';
import { totp } from '../../src/common/crypto';
import { fieldKeyring } from '../../src/config/config';
import { DB } from '../../src/database/database.module';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

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

  // ADR 0118: ما تحقق منه مدير النظام (الاسم القانوني والبلد) لا يتغيّر بعد التحقق دون تحقق جديد
  it('a buyer admin changing the legal name or country of a verified organization sends it back to pending_verification; billing email changes are audited', async () => {
    const o = await created();
    const owner = await buyer(o.id, 'buyer_admin');
    await activate(o.id);
    const fields = async () => {
      const current = await get(owner.token, `/buyer-organizations/${o.id}`).expect(200);
      const { id: _i, active_members: _a, verified_at: _v, created_at: _c, updated_at: _u, ...rest } = current.body;
      return rest;
    };
    const mail = await write('put', owner.token, `/buyer-organizations/${o.id}`, { ...(await fields()), billing_email: 'accounts@example.test' }).expect(200);
    expect(mail.body).toMatchObject({ status: 'active', billing_email: 'accounts@example.test', verified_at: expect.any(String) });
    const { rows: audits } = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'buyer_organization.billing_email_changed' AND details->>'organization_id' = $1`, [o.id]);
    expect(audits).toEqual([{ details: { organization_id: o.id, reason_code: 'billing_email_changed' } }]);
    expect(JSON.stringify(audits)).not.toContain('accounts@example.test');

    for (const change of [{ legal_name: 'Another Name LLC' }, { country: 'PS' }]) {
      await activate(o.id);
      const res = await write('put', owner.token, `/buyer-organizations/${o.id}`, { ...(await fields()), ...change }).expect(200);
      expect(res.body).toMatchObject({ ...change, status: 'pending_verification', verified_at: null });
    }
    const { rows: events } = await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'buyer_organization.status_changed' AND aggregate_id = $1 ORDER BY id`, [o.id]);
    expect(events.map((e) => [e.payload.from, e.payload.to])).toEqual([
      ['pending_verification', 'active'],
      ['active', 'pending_verification'],
      ['pending_verification', 'active'],
      ['active', 'pending_verification'],
    ]);
    // مدير النظام هو المتحقق: تعديله لا يعيدها
    await activate(o.id);
    const byAdmin = await write('put', admin.token, `/buyer-organizations/${o.id}`, { ...(await fields()), legal_name: 'Corrected LLC' }).expect(200);
    expect(byAdmin.body).toMatchObject({ status: 'active', legal_name: 'Corrected LLC' });
  });

  // ADR 0118: عضوية المؤسسة مستقلة عن تعليق الحساب على المنصة، والتعليق بأي طريق يبطل كل الوصول
  it('a buyer admin suspends the membership (access revoked at once) but never lifts a platform suspension', async () => {
    const o = await created({ seats: 10 });
    const owner = await buyer(o.id, 'buyer_admin');
    await activate(o.id);
    const email = `member-${randomUUID()}@example.test`;
    const password = randomUUID();
    const { rows } = await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, $2, $3) RETURNING id`, [email, await hash(password), o.id]);
    const memberId = rows[0]!.id;
    await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, 'buyer_member', 'organization', $2)`, [memberId, o.id]);
    const signIn = () => http().post('/v1/auth/login').send({ email, password });
    const session = (await signIn().expect(200)).body;
    const member = (status: 'active' | 'suspended', t = owner.token) =>
      write('put', t, `/buyer-organizations/${o.id}/members/${memberId}`, { role: 'buyer_member', status });

    expect((await member('suspended').expect(200)).body.status).toBe('suspended');
    await get(session.access_token, '/auth/me').expect(401);
    await http().post('/v1/auth/refresh').send({ refresh_token: session.refresh_token }).expect(401);
    await signIn().expect(401);
    expect((await h.pool.query(`SELECT status, membership_suspended FROM users WHERE id = $1`, [memberId])).rows[0]).toEqual({ status: 'active', membership_suspended: true });
    await member('active').expect(200);
    await signIn().expect(200);

    // تعليق مدير النظام على المنصة: مدير المؤسسة لا يرفعه، والعضو يبقى معلّقًا ولا يدخل
    await http().put(`/v1/users/${memberId}/status`).set(auth(admin.token)).set('Idempotency-Key', randomUUID()).send({ status: 'suspended' }).expect(204);
    expect((await member('active').expect(403)).body.code).toBe('forbidden_role');
    await member('active', admin.token).expect(403);
    const listed = (await get(owner.token, `/buyer-organizations/${o.id}/members`).expect(200)).body.items.find((m: { user_id: string }) => m.user_id === memberId);
    expect(listed.status).toBe('suspended');
    await signIn().expect(401);
    // تعليق العضوية فوقه لا يغيّر حالة المنصة، ورفع مدير النظام وحده لا يكفي ما دامت العضوية معلّقة
    await member('suspended').expect(200);
    await http().put(`/v1/users/${memberId}/status`).set(auth(admin.token)).set('Idempotency-Key', randomUUID()).send({ status: 'active' }).expect(204);
    await signIn().expect(401);
    await member('active').expect(200);
    await signIn().expect(200);
  });

  it('invites within the seats only (409 seats_exhausted), and keeps one active admin (409 last_buyer_admin)', async () => {
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

    await activate(o.id);
    expect((await write('put', owner.token, `/buyer-organizations/${o.id}/members/${owner.id}`, { role: 'buyer_member', status: 'active' }).expect(409)).body.code).toBe('last_buyer_admin');
    expect((await write('put', admin.token, `/buyer-organizations/${o.id}/members/${owner.id}`, { role: 'buyer_admin', status: 'suspended' }).expect(409)).body.code).toBe('last_buyer_admin');
    // عضو مؤسسة أخرى أو معرّف مجهول 404
    await write('put', owner.token, `/buyer-organizations/${o.id}/members/${randomUUID()}`, { role: 'buyer_member', status: 'active' }).expect(404);
    await write('post', owner.token, `/buyer-organizations/${other.id}/members`, { email: `x-${randomUUID()}@example.test`, role: 'buyer_member' }).expect(404);
  });
  // متابعة أمن #304: بريد حساب قائم خارج المؤسسة لا يُكشف بالرد؛ التعارض عضو مدعو في طابور مدير النظام
  it('an invite for an email taken outside the organization answers exactly like a fresh invite, and queues the conflict for a system admin', async () => {
    const o = await created({ seats: 5 });
    const owner = await buyer(o.id, 'buyer_admin');
    const reporter = await seedUser(h, { roles: [{ role: 'reporter' }] });
    const invite = (email: string) => write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email, role: 'buyer_member' });
    const fresh = await invite(`fresh-${randomUUID()}@example.test`).expect(201);
    const taken = await invite(reporter.email.toUpperCase()).expect(201);

    // الرد نفسه بايتًا ببايت بعد إخفاء ما يتغير بطبعه في كل دعوة (المعرّف والبريد والطابع والرمز)
    const mask = (res: request.Response) => {
      const body = res.text
        .replace(/"user_id":"[0-9a-f-]{36}"/, '"user_id":"<id>"')
        .replace(/"email":"[^"]*"/, '"email":"<email>"')
        .replace(/"created_at":"[^"]*"/, '"created_at":"<t>"')
        .replace(/"invite_token":"[A-Za-z0-9_-]+"/, '"invite_token":"<token>"')
        .replace(/"invite_token_expires_at":"[^"]*"/, '"invite_token_expires_at":"<t>"');
      const headers = Object.keys(res.headers).filter((k) => !['date', 'etag', 'x-request-id', 'content-length'].includes(k)).sort();
      return { status: res.status, headers, contentType: res.headers['content-type'], body };
    };
    expect(mask(taken)).toEqual(mask(fresh));
    expect(taken.text.length - taken.body.email.length).toBe(fresh.text.length - fresh.body.email.length);
    expect(taken.body.invite_token).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));

    // يظهر مدعوًّا في القائمة ويشغل مقعدًا، ويُعدَّل كأي مدعو
    const listed = (await get(owner.token, `/buyer-organizations/${o.id}/members`).expect(200)).body.items;
    expect(listed.find((m: { user_id: string }) => m.user_id === taken.body.user_id)).toEqual({ ...taken.body, invite_token: undefined, invite_token_expires_at: undefined, created_at: expect.any(String) });
    await write('put', owner.token, `/buyer-organizations/${o.id}/members/${taken.body.user_id}`, { role: 'buyer_admin', status: 'suspended' }).expect(200);
    expect((await get(owner.token, `/buyer-organizations/${o.id}/members`).expect(200)).body.items.find((m: { user_id: string }) => m.user_id === taken.body.user_id)).toMatchObject({ role: 'buyer_admin', status: 'suspended' });
    await write('put', owner.token, `/buyer-organizations/${o.id}/members/${taken.body.user_id}`, { role: 'buyer_member', status: 'active' }).expect(200);

    // البريد نفسه مرة أخرى في المؤسسة نفسها 409 كأي عضو ظاهر فيها؛ والحساب القائم لا يُمس
    expect((await invite(reporter.email).expect(409)).body.code).toBe('bad_request');
    expect((await invite(fresh.body.email).expect(409)).body.code).toBe('bad_request');
    const { rows: [u] } = await h.pool.query(`SELECT organization_id, status FROM users WHERE id = $1`, [reporter.id]);
    expect(u).toEqual({ organization_id: null, status: 'active' });
    await http().post('/v1/auth/recovery/complete').send({ reset_token: taken.body.invite_token, new_password: 'a long enough passphrase 1' }).expect(401);

    // الطابور: مدير النظام يراه بالمعرّفات ويحسمه برمز TOTP صحيح، فيخرج من القائمة والمقاعد
    const db = h.app.get(DB);
    const queued = (await openInviteConflicts(db)).find((c) => c.id === taken.body.user_id);
    expect(queued).toMatchObject({ organizationId: o.id, existingUserId: reporter.id, role: 'buyer_member', state: 'pending' });
    const sysadmin = await seedUser(h, { totp: true, roles: [{ role: 'system_admin' }] });
    const deps = { keyring: fieldKeyring(h.config) };
    await expect(dismissInviteConflict(db, deps, { conflictId: queued!.id, adminId: sysadmin.id, totp: '000000' })).rejects.toMatchObject({ code: 'totp_failed' });
    await expect(dismissInviteConflict(db, deps, { conflictId: queued!.id, adminId: owner.id, totp: '000000' })).rejects.toMatchObject({ code: 'invalid_admin' });
    await dismissInviteConflict(db, deps, { conflictId: queued!.id, adminId: sysadmin.id, totp: totp(sysadmin.totpSecret!, Date.now()) });
    await expect(dismissInviteConflict(db, deps, { conflictId: queued!.id, adminId: sysadmin.id, totp: totp(sysadmin.totpSecret!, Date.now()) })).rejects.toMatchObject({ code: 'already_resolved' });
    expect((await get(owner.token, `/buyer-organizations/${o.id}/members`).expect(200)).body.items.map((m: { user_id: string }) => m.user_id)).not.toContain(taken.body.user_id);
    const { rows: audits } = await h.pool.query(`SELECT action, details FROM audit_log WHERE target_id = $1 ORDER BY id`, [reporter.id]);
    expect(audits.map((a) => [a.action, a.details.conflict_id])).toEqual([
      ['buyer_member.invite_conflict', queued!.id],
      ['buyer_member.invite_conflict_resolved', queued!.id],
    ]);
    expect(JSON.stringify(audits)).not.toContain(reporter.email.toLowerCase());
  });
});
