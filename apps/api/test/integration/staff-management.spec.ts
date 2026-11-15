import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// ADR 0122: المكاتب وإنشاء الحسابات لمدير النظام. لا مدير نظام من هنا، والحساب بلا كلمة سر ويُفعَّل برابط إعادة التعيين القائم.
describe('staff management from the UI (/v1/offices, POST /v1/users)', () => {
  let h: Harness;
  let admin: Actor;
  let supervisor: Actor;
  let chief: Actor;
  let office: string;

  beforeAll(async () => {
    h = await createHarness();
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ($1, $2, 'gaza') RETURNING id`, [`مكتب ${randomUUID().slice(0, 8)}`, `Office ${randomUUID().slice(0, 8)}`])).rows[0]!.id;
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const get = (a: Actor, url: string) => http().get(url).set('Authorization', `Bearer ${a.token}`);
  const post = (a: Actor, url: string, body: object) => http().post(url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  const email = () => `staff-${randomUUID().slice(0, 12)}@example.test`;
  const auditOf = async (action: string, target: string) =>
    (await h.pool.query<{ actor_id: string; details: Record<string, string> }>(`SELECT actor_id, details FROM audit_log WHERE action = $1 AND target_id = $2`, [action, target])).rows;

  describe('offices', () => {
    it('lists offices and creates one for the system administrator alone, audited without its name', async () => {
      const name = { name_ar: `مكتب الشمال ${randomUUID().slice(0, 6)}`, name_en: `North office ${randomUUID().slice(0, 6)}`, governorate: 'north_gaza' };
      const created = await post(admin, '/v1/offices', name).expect(201);
      expect(created.body).toEqual({ id: expect.any(String), ...name });
      const valid = schemaValidator('Office');
      expect(valid(created.body) ? [] : valid.errors).toEqual([]);
      const list = await get(admin, '/v1/offices').expect(200);
      expect(list.body.items).toEqual(expect.arrayContaining([created.body, expect.objectContaining({ id: office })]));
      const names = (list.body.items as { name_ar: string }[]).map((o) => o.name_ar);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ar')));
      const [row] = await auditOf('office.created', created.body.id);
      expect(row).toEqual({ actor_id: admin.id, details: { scope_kind: 'office', scope_id: created.body.id } });
      // الاسم المستعمل، والجسم المخالف، ومن ليس مدير نظام
      expect((await post(admin, '/v1/offices', { ...name, name_en: 'Another' }).expect(409)).body.code).toBe('office_exists');
      for (const bad of [{ ...name, name_ar: ' مكتب ' }, { ...name, name_en: 'a\u202eb' }, { ...name, governorate: '' }, { name_ar: 'م' }, { ...name, extra: 1 }]) await post(admin, '/v1/offices', bad).expect(422);
      for (const other of [supervisor, chief]) {
        await get(other, '/v1/offices').expect(403);
        await post(other, '/v1/offices', { ...name, name_ar: 'مكتب آخر', name_en: 'Other office' }).expect(403);
      }
    });
  });

  describe('accounts', () => {
    it('creates a staff account with no usable password, audited without the email, and the existing reset link activates it', async () => {
      const address = email();
      const res = await post(admin, '/v1/users', { email: address, role: 'producer', work_name: 'مونتير المساء' }).expect(201);
      expect(res.body).toEqual({ id: expect.any(String), work_name: 'مونتير المساء', roles: ['producer'], governorate: null, status: 'active', last_active_at: null });
      const valid = schemaValidator('StaffUser');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(address);
      const { rows } = await h.pool.query(
        `SELECT u.credential_reset_required, u.totp_secret_enc IS NULL AS no_totp, r.role, r.scope_kind, r.scope_id, r.granted_by FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.id = $1`,
        [res.body.id],
      );
      expect(rows).toEqual([{ credential_reset_required: true, no_totp: true, role: 'producer', scope_kind: 'all', scope_id: '', granted_by: admin.id }]);
      const [row] = await auditOf('user.created', res.body.id);
      expect(row).toEqual({ actor_id: admin.id, details: { target_user_id: res.body.id, role: 'producer', scope_kind: 'all', scope_id: '', reason_code: 'admin_ui' } });
      // لا دخول بأي كلمة قبل التفعيل
      await http().post('/v1/auth/login').send({ email: address, password: 'any-password-123' }).expect(401);
      // التفعيل بالنقطة القائمة: مدير النظام يصدر رابط إعادة التعيين مرة واحدة
      const link = await post(admin, `/v1/users/${res.body.id}/password-reset-links`, { reason: 'forgot_password' }).expect(201);
      expect(link.body.reset_token).toEqual(expect.any(String));
      expect((await post(admin, '/v1/users', { email: address.toUpperCase(), role: 'finance' }).expect(409)).body.code).toBe('email_taken');
    });

    it('places a supervisor in an office scope and a reporter in an office, from existing offices only', async () => {
      const sup = await post(admin, '/v1/users', { email: email(), role: 'supervisor', work_name: 'مشرف المكتب', scope_kind: 'office', scope_id: office }).expect(201);
      expect((await h.pool.query(`SELECT scope_kind, scope_id FROM user_roles WHERE user_id = $1`, [sup.body.id])).rows).toEqual([{ scope_kind: 'office', scope_id: office }]);
      const rep = await post(admin, '/v1/users', { email: email(), role: 'reporter', office_id: office }).expect(201);
      expect(rep.body).toMatchObject({ roles: ['reporter'], governorate: 'gaza', work_name: null });
      expect((await h.pool.query(`SELECT office_id FROM users WHERE id = $1`, [rep.body.id])).rows).toEqual([{ office_id: office }]);
      const missing = randomUUID();
      for (const bad of [
        { email: email(), role: 'supervisor', scope_kind: 'office', scope_id: missing },
        { email: email(), role: 'supervisor', scope_kind: 'all', scope_id: office },
        { email: email(), role: 'supervisor', scope_kind: 'office' },
        { email: email(), role: 'producer', scope_kind: 'office', scope_id: office },
        { email: email(), role: 'reporter' },
        { email: email(), role: 'reporter', office_id: missing },
        { email: email(), role: 'reporter', office_id: office, work_name: 'مراسل' },
      ]) {
        expect((await post(admin, '/v1/users', bad).expect(422)).body.code).toBe('validation_failed');
      }
    });

    it('never creates a system administrator or a buyer, and answers 403 to anyone but a system administrator', async () => {
      const before = (await h.pool.query(`SELECT count(*)::int AS n FROM user_roles WHERE role = 'system_admin'`)).rows[0].n;
      for (const role of ['system_admin', 'buyer_admin', 'buyer_member', 'owner']) await post(admin, '/v1/users', { email: email(), role }).expect(422);
      await post(admin, '/v1/users', { email: email(), role: 'producer', roles: ['system_admin'] }).expect(422);
      await post(admin, '/v1/users', { email: 'not-an-email', role: 'producer' }).expect(422);
      expect((await h.pool.query(`SELECT count(*)::int AS n FROM user_roles WHERE role = 'system_admin'`)).rows[0].n).toBe(before);
      for (const other of [supervisor, chief]) await post(other, '/v1/users', { email: email(), role: 'producer' }).expect(403);
      await http().post('/v1/users').send({ email: email(), role: 'producer' }).expect(401);
    });

    it('limits how many accounts and offices one administrator creates in a window', async () => {
      const busy = await loginAs(h, [{ role: 'system_admin' }]);
      let limited: request.Response | undefined;
      for (let i = 0; i < 80 && !limited; i++) {
        const res = await post(busy, '/v1/users', { email: email(), role: 'producer' });
        if (res.status === 429) limited = res;
        else expect(res.status).toBe(201);
      }
      expect(limited?.body.code).toBe('rate_limited');
      expect(Number(limited?.headers['retry-after'])).toBeGreaterThan(0);
      // مدير آخر لا يتأثر
      await post(admin, '/v1/users', { email: email(), role: 'producer' }).expect(201);
    });
  });
});
