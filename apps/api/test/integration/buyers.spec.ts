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
    const { id: _i, active_members: _a, invited_members: _n, verified_at: _v, created_at: _c, updated_at: _u, ...fields } = current.body;
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
    const { id: _i, active_members: _a, invited_members: _n, verified_at: _v, created_at: _c, updated_at: _u, ...fields } = current.body;
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
      const { id: _i, active_members: _a, invited_members: _n, verified_at: _v, created_at: _c, updated_at: _u, ...rest } = current.body;
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

    // البريد نفسه مرة أخرى في المؤسسة نفسها، ودعوته لم يكتمل قبولها: إعادة إصدار بالشكل نفسه للاثنين (العضو نفسه برمز جديد)؛
    // والحساب القائم لا يُمس
    const again = await invite(fresh.body.email).expect(201);
    const againTaken = await invite(reporter.email).expect(201);
    expect(mask(againTaken)).toEqual(mask(again));
    expect([again.body.user_id, againTaken.body.user_id]).toEqual([fresh.body.user_id, taken.body.user_id]);
    expect(again.body.invite_token).not.toBe(fresh.body.invite_token);
    taken.body.invite_token = againTaken.body.invite_token;
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
      ['buyer_member.invitation_reissued', queued!.id],
      ['buyer_member.invite_conflict_resolved', queued!.id],
    ]);
    expect(JSON.stringify(audits)).not.toContain(reporter.email.toLowerCase());
  });

  const del = (t: string, url: string, key: string = randomUUID()) => http().delete(`/v1${url}`).set(auth(t)).set('Idempotency-Key', key);
  const complete = (token: string) => http().post('/v1/auth/recovery/complete').send({ reset_token: token, new_password: 'a long enough passphrase 1' });
  const membersOf = async (t: string, orgId: string): Promise<Array<{ user_id: string; email: string; role: string; status: string }>> =>
    (await get(t, `/buyer-organizations/${orgId}/members`).expect(200)).body.items;

  // قرار المنسّق 2026-11-15: المدعو الذي استعمل رمزه ولم يُكمل ربط التحقق بخطوتين يُعاد إصدار رمزه من مدير مؤسسته
  it('reissues the invitation of a member who has not completed acceptance: the previous token and session die, the new token completes', async () => {
    const o = await created({ seats: 5 });
    const owner = await buyer(o.id, 'buyer_admin');
    const member = await buyer(o.id, 'buyer_member');
    const invited = (await write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email: `m-${randomUUID()}@example.test`, role: 'buyer_member' }).expect(201)).body;
    const url = `/buyer-organizations/${o.id}/members/${invited.user_id}/invitation`;

    // استعمل رمزه وترك الخطوة الثانية: يبقى مدعوًّا، وسرّه المعلّق في حسابه
    const abandoned = (await complete(invited.invite_token).expect(200)).body;
    expect((await membersOf(owner.token, o.id)).find((m) => m.user_id === invited.user_id)).toMatchObject({ status: 'invited' });

    const key = randomUUID();
    const reissued = await write('post', owner.token, url, {}, { key }).expect(200);
    const valid = schemaValidator('BuyerMemberCreated');
    expect(valid(reissued.body) ? [] : valid.errors).toEqual([]);
    expect(reissued.body).toMatchObject({ user_id: invited.user_id, email: invited.email, role: 'buyer_member', status: 'invited' });
    expect(reissued.body.invite_token).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/));
    expect(reissued.body.invite_token).not.toBe(invited.invite_token);
    // إعادة الطلب بالمفتاح نفسه لا تعيد الرمز ولا تصدر غيره
    const replay = await write('post', owner.token, url, {}, { key }).expect(200);
    expect(replay.body).not.toHaveProperty('invite_token');

    // الجلسة المقيّدة السابقة وسرّها المعلّق لا يبقيان: الدورة تبدأ من أولها بالرمز الجديد
    await http().post('/v1/auth/totp/confirm').set(auth(abandoned.session.access_token)).send({ totp_code: '000000' }).expect(401);
    const { rows: [u] } = await h.pool.query(`SELECT totp_pending_secret_enc IS NULL AS cleared, credential_reset_required FROM users WHERE id = $1`, [invited.user_id]);
    expect(u).toEqual({ cleared: true, credential_reset_required: true });
    const { rows: open } = await h.pool.query(`SELECT count(*)::int AS n FROM recovery_requests WHERE user_id = $1 AND state = 'approved' AND completed_at IS NULL`, [invited.user_id]);
    expect(open[0].n).toBe(1);

    // إصدار ثانٍ قبل استعمال الأول: الأول يموت والثاني يُكمل
    const second = (await write('post', owner.token, url, {}).expect(200)).body;
    await complete(reissued.body.invite_token).expect(401);
    await complete(second.invite_token).expect(200);

    // لا مقعد إضافي، ولغير المدعو 409، وللمجهول أو عضو مؤسسة أخرى 404، وللعضو غير المدير 403
    expect(await membersOf(owner.token, o.id)).toHaveLength(4);
    expect((await write('post', owner.token, `/buyer-organizations/${o.id}/members/${owner.id}/invitation`, {}).expect(409)).body.code).toBe('invalid_transition');
    await write('post', owner.token, `/buyer-organizations/${o.id}/members/${randomUUID()}/invitation`, {}).expect(404);
    const other = await created();
    const foreign = (await membersOf(admin.token, other.id))[0]!;
    await write('post', owner.token, `/buyer-organizations/${o.id}/members/${foreign.user_id}/invitation`, {}).expect(404);
    await write('post', owner.token, `/buyer-organizations/${other.id}/members/${foreign.user_id}/invitation`, {}).expect(404);
    await write('post', member.token, url, {}).expect(403);
    await write('post', admin.token, `/buyer-organizations/${other.id}/members/${foreign.user_id}/invitation`, {}).expect(200);

    const { rows: audits } = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'buyer_member.invitation_reissued' AND target_id = $1`, [invited.user_id]);
    expect(audits).toHaveLength(2);
    expect(audits[0].details).toMatchObject({ organization_id: o.id, target_user_id: invited.user_id });
    expect(JSON.stringify(audits)).not.toContain(invited.email);
  });

  it('inviting again an email whose acceptance is incomplete is a reissue even with every seat taken; an accepted member stays 409', async () => {
    const o = await created({ seats: 2 });
    const owner = await buyer(o.id, 'buyer_admin');
    const first = (await membersOf(owner.token, o.id)).find((m) => m.user_id !== owner.id)!;
    const again = await write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email: first.email.toUpperCase(), role: 'buyer_member' }).expect(201);
    expect(again.body).toMatchObject({ user_id: first.user_id, email: first.email, role: 'buyer_member', status: 'invited', invite_token: expect.any(String) });
    expect(again.body.invite_token).not.toBe(o.invite_token);
    await complete(o.invite_token).expect(401);
    await complete(again.body.invite_token).expect(200);
    expect(await membersOf(owner.token, o.id)).toHaveLength(2);

    const { rows: [mine] } = await h.pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [owner.id]);
    const taken = await write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email: mine!.email, role: 'buyer_member' }).expect(409);
    expect(taken.body).toMatchObject({ code: 'seats_exhausted' });
    const roomy = await created({ seats: 5 });
    const boss = await buyer(roomy.id, 'buyer_admin');
    const { rows: [bossRow] } = await h.pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [boss.id]);
    expect((await write('post', boss.token, `/buyer-organizations/${roomy.id}/members`, { email: bossRow!.email, role: 'buyer_member' }).expect(409)).body).toMatchObject({
      code: 'bad_request',
      details: { fields: ['/email'] },
    });
  });

  it('cancels an invitation: the seat is freed, the token dies and the member leaves the list; a conflict row behaves the same', async () => {
    const o = await created({ seats: 4 });
    const owner = await buyer(o.id, 'buyer_admin');
    const reporter = await seedUser(h, { roles: [{ role: 'reporter' }] });
    const invite = (email: string) => write('post', owner.token, `/buyer-organizations/${o.id}/members`, { email, role: 'buyer_member' });
    const profile = async () => (await get(owner.token, `/buyer-organizations/${o.id}`).expect(200)).body;
    const real = (await invite(`m-${randomUUID()}@example.test`).expect(201)).body;
    const conflict = (await invite(reporter.email).expect(201)).body;
    // المالك والمدير الأول المدعو والمدعوان: المقاعد الأربعة مشغولة، والعدّاد يفصّلها
    expect(await profile()).toMatchObject({ seats: 4, active_members: 1, invited_members: 3 });
    expect((await invite(`x-${randomUUID()}@example.test`).expect(409)).body.code).toBe('seats_exhausted');

    // إعادة الإصدار على التعارض بشكل إعادة الإصدار على العضو الحقيقي
    const mask = (res: request.Response) =>
      res.text
        .replace(/"user_id":"[0-9a-f-]{36}"/, '"user_id":"<id>"')
        .replace(/"email":"[^"]*"/, '"email":"<email>"')
        .replace(/"created_at":"[^"]*"/, '"created_at":"<t>"')
        .replace(/"invite_token":"[A-Za-z0-9_-]{43}"/, '"invite_token":"<token>"')
        .replace(/"invite_token_expires_at":"[^"]*"/, '"invite_token_expires_at":"<t>"');
    const reissuedReal = await write('post', owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}/invitation`, {}).expect(200);
    const reissuedConflict = await write('post', owner.token, `/buyer-organizations/${o.id}/members/${conflict.user_id}/invitation`, {}).expect(200);
    expect(mask(reissuedConflict)).toBe(mask(reissuedReal));
    expect(mask(reissuedReal)).toContain('<token>');

    const key = randomUUID();
    await del(owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}/invitation`, key).expect(204);
    await del(owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}/invitation`, key).expect(204);
    await del(owner.token, `/buyer-organizations/${o.id}/members/${conflict.user_id}/invitation`).expect(204);
    // خرجا من القائمة والمقاعد وطابور مدير النظام، والرمز مات
    const listed = (await membersOf(owner.token, o.id)).map((m) => m.user_id);
    expect(listed).not.toContain(real.user_id);
    expect(listed).not.toContain(conflict.user_id);
    expect(await profile()).toMatchObject({ active_members: 1, invited_members: 1 });
    expect((await openInviteConflicts(h.app.get(DB))).map((c) => c.id)).not.toContain(conflict.user_id);
    await complete(reissuedReal.body.invite_token).expect(401);
    await del(owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}/invitation`).expect(404);
    await write('post', owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}/invitation`, {}).expect(404);
    await write('put', owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}`, { role: 'buyer_member', status: 'active' }).expect(404);
    const { rows: [reporterRow] } = await h.pool.query(`SELECT organization_id, status FROM users WHERE id = $1`, [reporter.id]);
    expect(reporterRow).toEqual({ organization_id: null, status: 'active' });

    // دعوة البريد نفسه من جديد دعوة جديدة تشغل مقعدًا، بالمعرّف نفسه للاثنين
    const back = await invite(real.email).expect(201);
    const backConflict = await invite(reporter.email).expect(201);
    expect([back.body.user_id, backConflict.body.user_id]).toEqual([real.user_id, conflict.user_id]);
    expect(mask(backConflict)).toBe(mask(back));
    expect(back.body).toMatchObject({ status: 'invited', role: 'buyer_member' });
    expect(await profile()).toMatchObject({ active_members: 1, invited_members: 3 });
    // الملغاة لا تعود فوق حد المقاعد
    await del(owner.token, `/buyer-organizations/${o.id}/members/${real.user_id}/invitation`).expect(204);
    await invite(`y-${randomUUID()}@example.test`).expect(201);
    expect((await invite(real.email).expect(409)).body.code).toBe('seats_exhausted');
    await complete(back.body.invite_token).expect(401);

    // لغير المدعو 409، وللعضو غير المدير 403، والتدقيق بلا البريد
    expect((await del(owner.token, `/buyer-organizations/${o.id}/members/${owner.id}/invitation`).expect(409)).body.code).toBe('invalid_transition');
    const { rows: audits } = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'buyer_member.invitation_cancelled' AND details->>'organization_id' = $1`, [o.id]);
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain(real.email);
    expect(JSON.stringify(audits)).not.toContain(reporter.email.toLowerCase());

    // مؤسسة فعّالة لا يُلغى مديرها الوحيد
    const lone = await created();
    await activate(lone.id);
    const only = (await membersOf(admin.token, lone.id))[0]!;
    expect((await del(admin.token, `/buyer-organizations/${lone.id}/members/${only.user_id}/invitation`).expect(409)).body.code).toBe('last_buyer_admin');
  });
});
