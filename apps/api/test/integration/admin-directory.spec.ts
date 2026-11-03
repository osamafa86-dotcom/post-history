import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, type Harness, loginAs, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// حسابات الطاقم وهوية المنصة لمدير النظام (ADR 0099، A1 وA6)
describe('staff directory and platform settings', () => {
  let h: Harness;
  let admin: Actor;
  let finance: Actor;
  let chief: Actor;
  let office: string;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    h = await createHarness();
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', 'khan_younis') RETURNING id`)).rows[0]!.id;
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const get = (a: Actor, url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`);
  const put = (a: Actor, url: string, body: object, headers: Record<string, string> = {}, key = randomUUID()) =>
    http().put(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).set(headers).send(body);

  describe('GET /users', () => {
    it('lists staff accounts with the A1 fields only, filtered by role, status and a name or email fragment, and paged', async () => {
      const reporter = await seedUser(h, { roles: [{ role: 'reporter' }] });
      await h.pool.query(`UPDATE users SET work_name = $2, office_id = $3, last_login_at = now() WHERE id = $1`, [reporter.id, `مراسل تجريبي ${run}`, office]);
      const suspended = await seedUser(h, { roles: [{ role: 'supervisor' }, { role: 'reporter' }], status: 'suspended' });
      await h.pool.query(`UPDATE users SET work_name = $2 WHERE id = $1`, [suspended.id, `محرر تجريبي ${run}`]);
      const org = (await h.pool.query<{ id: string }>(
        `INSERT INTO buyer_organizations (legal_name, display_name_ar, display_name_en, country, billing_email) VALUES ('B', 'م', 'B', 'JO', 'b@example.test') RETURNING id`)).rows[0]!.id;
      const buyer = (await h.pool.query<{ id: string }>(`INSERT INTO users (email, password_hash, organization_id) VALUES ($1, 'x', $2) RETURNING id`, [`buyer-${run}@example.test`, org])).rows[0]!.id;
      await h.pool.query(`INSERT INTO user_roles (user_id, role, scope_kind, scope_id) VALUES ($1, 'buyer_admin', 'organization', $2)`, [buyer, org]);

      const res = await get(admin, `/users?q=${encodeURIComponent(run)}`).expect(200);
      const valid = schemaValidator('StaffUserPage');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      expect(res.body.items).toEqual([
        { id: suspended.id, work_name: `محرر تجريبي ${run}`, roles: ['reporter', 'supervisor'], governorate: null, status: 'suspended', last_active_at: null },
        { id: reporter.id, work_name: `مراسل تجريبي ${run}`, roles: ['reporter'], governorate: 'khan_younis', status: 'active', last_active_at: expect.any(String) },
      ]);
      // لا بريد ولا اسم حقيقي ولا حساب مشترٍ
      expect(JSON.stringify(res.body)).not.toContain('@');
      expect((await get(admin, `/users?q=${encodeURIComponent(`buyer-${run}`)}`).expect(200)).body.items).toEqual([]);
      // البحث بجزء من البريد يجد الحساب ولا يعيد البريد
      const byEmail = await get(admin, `/users?q=${encodeURIComponent(reporter.email.slice(5, 20))}`).expect(200);
      expect(byEmail.body.items.map((u: { id: string }) => u.id)).toEqual([reporter.id]);

      expect((await get(admin, `/users?q=${run}&role=supervisor`).expect(200)).body.items.map((u: { id: string }) => u.id)).toEqual([suspended.id]);
      expect((await get(admin, `/users?q=${run}&role=supervisor&role=reporter`).expect(200)).body.items).toHaveLength(2);
      expect((await get(admin, `/users?q=${run}&status=active`).expect(200)).body.items.map((u: { id: string }) => u.id)).toEqual([reporter.id]);

      const first = await get(admin, `/users?q=${run}&limit=1`).expect(200);
      expect(first.body.items.map((u: { id: string }) => u.id)).toEqual([suspended.id]);
      const second = await get(admin, `/users?q=${run}&limit=1&cursor=${first.body.next_cursor}`).expect(200);
      expect(second.body.items.map((u: { id: string }) => u.id)).toEqual([reporter.id]);
      expect(second.body.next_cursor).toBeNull();

      // الملخص على كل الطاقم لا على المرشّح
      const { summary } = res.body;
      const { rows } = await h.pool.query<{ n: number; s: number }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'suspended')::int AS s FROM users WHERE organization_id IS NULL`);
      expect(summary).toMatchObject({ total: rows[0]!.n, suspended: rows[0]!.s });
      expect(summary.roles.find((r: { role: string }) => r.role === 'buyer_admin')).toBeUndefined();
      expect(summary.roles.find((r: { role: string }) => r.role === 'reporter').count).toBeGreaterThanOrEqual(2);
    });

    it('is the admin’s alone; a bad cursor or role is 400', async () => {
      for (const a of [finance, chief]) expect((await get(a, '/users').expect(403)).body.code).toBe('forbidden_role');
      expect((await get(admin, '/users?cursor=bad').expect(400)).body.code).toBe('bad_request');
      expect((await get(admin, '/users?role=editor').expect(400)).body.code).toBe('bad_request');
    });
  });

  describe('platform settings', () => {
    it('reads the seeded identity with its version as the ETag, for the admin only', async () => {
      const res = await get(admin, '/platform-settings').expect(200);
      expect(res.headers.etag).toBe(`"${res.body.version}"`);
      const valid = schemaValidator('PlatformSettings');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      for (const a of [finance, chief]) expect((await get(a, '/platform-settings').expect(403)).body.code).toBe('forbidden_role');
    });

    it('replaces the three texts with If-Match; the same values write nothing; event and audit carry the version and field names only', async () => {
      const before = (await get(admin, '/platform-settings').expect(200)).body;
      const next = { platform_name: before.platform_name, app_name: before.app_name, watermark_text: `معاينة ${run}` };
      const res = await put(admin, '/platform-settings', next, { 'If-Match': `"${before.version}"` }).expect(200);
      expect(res.body).toMatchObject({ ...next, version: before.version + 1 });
      expect(res.headers.etag).toBe(`"${before.version + 1}"`);
      expect((await put(admin, '/platform-settings', next).expect(200)).body.version).toBe(before.version + 1);

      const events = (await h.pool.query<{ aggregate_id: string; payload: Record<string, unknown> }>(
        `SELECT aggregate_id, payload FROM outbox_events WHERE type = 'platform_settings.changed' AND idempotency_key = $1`,
        [`platform_settings.changed:${before.version + 1}`])).rows;
      expect(events).toEqual([{ aggregate_id: admin.id, payload: { settings_version: before.version + 1, changed_fields: ['watermark_text'] } }]);
      const audit = (await h.pool.query<{ details: Record<string, unknown> }>(
        `SELECT details FROM audit_log WHERE action = 'platform_settings.changed' AND actor_id = $1`, [admin.id])).rows;
      expect(audit.at(-1)!.details).toEqual({ settings_version: before.version + 1, field_keys: ['watermark_text'] });
      expect(JSON.stringify(events) + JSON.stringify(audit)).not.toContain(run);

      // يعيد القيم كما كانت فلا يؤثر في ملفات أخرى
      await put(admin, '/platform-settings', { platform_name: before.platform_name, app_name: before.app_name, watermark_text: before.watermark_text }).expect(200);
    });

    it('rejects a stale If-Match with 412, invalid texts with 422 field paths, and other roles with 403', async () => {
      const now = (await get(admin, '/platform-settings').expect(200)).body;
      const body = { platform_name: now.platform_name, app_name: now.app_name, watermark_text: now.watermark_text };
      expect((await put(admin, '/platform-settings', { ...body, app_name: 'تطبيق' }, { 'If-Match': `"${now.version + 5}"` }).expect(412)).body.code).toBe('precondition_failed');
      const cases: Array<[object, string]> = [
        [{ ...body, platform_name: ' منصة' }, '/platform_name'],
        [{ ...body, app_name: 'ت'.repeat(41) }, '/app_name'],
        [{ ...body, watermark_text: 'معاينة\u202e' }, '/watermark_text'],
        [{ ...body, watermark_text: '' }, '/watermark_text'],
      ];
      for (const [input, field] of cases) {
        const res = await put(admin, '/platform-settings', input).expect(422);
        expect(res.body.details.fields).toContain(field);
      }
      expect((await put(admin, '/platform-settings', { platform_name: 'منصة' }).expect(422)).body.code).toBe('validation_failed');
      for (const a of [finance, chief]) expect((await put(a, '/platform-settings', body).expect(403)).body.code).toBe('forbidden_role');
      expect((await get(admin, '/platform-settings').expect(200)).body.version).toBe(now.version);
    });
  });
});
