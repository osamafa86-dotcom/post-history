import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, currentFormVersion, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// إدارة الوسوم (ADR 0098): القائمة المقترحة، واستعمال الوسوم، والدمج وإعادة التسمية في معاملة واحدة بلا نص وسم في حدث أو تدقيق
describe('tag administration', () => {
  let h: Harness;
  let formVersion: number;
  let reporter: Actor;
  let supervisor: Actor;
  let producer: Actor;
  let chief: Actor;
  let finance: Actor;
  let admin: Actor;
  // كل وسم في هذا الملف يحمل رمز التشغيل، فيُعزل عن وسوم الملفات الأخرى في القاعدة نفسها
  const run = randomUUID().slice(0, 8);
  const tag = (name: string) => `${name}-${run}`;

  beforeAll(async () => {
    h = await createHarness();
    formVersion = (await currentFormVersion(h)) + 1;
    await h.pool.query(`INSERT INTO upload_forms (version, schema) VALUES ($1, $2)`, [formVersion, { version: formVersion, fields: [] }]);
    reporter = await loginAs(h, [{ role: 'reporter' }]);
    supervisor = await loginAs(h, [{ role: 'supervisor' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`),
    put: (url: string, body: object, headers: Record<string, string> = {}, key: string = randomUUID()) =>
      http().put(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).set(headers).send(body),
    post: (url: string, body: object, key: string = randomUUID()) =>
      http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body),
  });
  const material = async (tags: string[]) =>
    (
      await as(reporter)
        .post('/materials', {
          title: 'عنوان تجريبي',
          material_types: ['report'],
          governorate: 'gaza',
          city: 'gaza',
          priority: 'normal',
          sensitivity: { minors: false, injured: false, graphic: false },
          display_name: { mode: 'network' },
          form_version: formVersion,
          dynamic_fields: {},
          tags,
        })
        .expect(201)
    ).body.id as string;
  const row = async (id: string) =>
    (await h.pool.query<{ tags: string[]; row_version: string; version: number; technical_state: string; editorial_state: string; rights_state: string }>(
      `SELECT tags, row_version, version, technical_state, editorial_state, rights_state FROM materials WHERE id = $1`, [id])).rows[0]!;
  const eventsSince = async (id: number) =>
    (await h.pool.query<{ id: string; type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
      `SELECT id, type, aggregate_type, aggregate_id, payload FROM outbox_events WHERE id > $1 AND type LIKE 'tag.%' ORDER BY id`, [id])).rows;
  const lastEventId = async () => Number((await h.pool.query<{ max: string | null }>(`SELECT max(id) FROM outbox_events`)).rows[0]!.max ?? 0);
  const current = async () => (await as(admin).get('/tag-suggestions').expect(200)).body as { tags: string[]; version: number };
  const usage = async (query: string) => (await as(admin).get(`/tags?q=${encodeURIComponent(run)}${query}`).expect(200)).body;

  describe('suggested list', () => {
    it('is read with its version as the ETag by the roles that write tags, and by no one else', async () => {
      const res = await as(reporter).get('/tag-suggestions').expect(200);
      expect(res.headers.etag).toBe(`"${res.body.version}"`);
      const valid = schemaValidator('TagSuggestions');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      for (const a of [supervisor, chief, admin]) await as(a).get('/tag-suggestions').expect(200);
      for (const a of [producer, finance]) expect((await as(a).get('/tag-suggestions').expect(403)).body.code).toBe('forbidden_role');
    });

    it('is replaced whole by the admin with If-Match; the same list again writes nothing; the event and audit carry the version only', async () => {
      const before = await current();
      const since = await lastEventId();
      const list = [tag('نزوح'), tag('مساعدات'), tag('مستشفى')];
      const res = await as(admin).put('/tag-suggestions', { tags: list }, { 'If-Match': `"${before.version}"` }).expect(200);
      expect(res.body).toMatchObject({ tags: list, version: before.version + 1 });
      expect(res.headers.etag).toBe(`"${before.version + 1}"`);
      // إعادة الترتيب طلب واحد كذلك
      const reordered = [list[2]!, list[0]!, list[1]!];
      const moved = await as(admin).put('/tag-suggestions', { tags: reordered }).expect(200);
      expect(moved.body).toMatchObject({ tags: reordered, version: before.version + 2 });
      const same = await as(admin).put('/tag-suggestions', { tags: reordered }).expect(200);
      expect(same.body.version).toBe(before.version + 2);

      const events = await eventsSince(since);
      expect(events.map((e) => [e.type, e.aggregate_type, e.aggregate_id, e.payload])).toEqual([
        ['tag.suggestions_changed', 'user', admin.id, { suggestions_version: before.version + 1 }],
        ['tag.suggestions_changed', 'user', admin.id, { suggestions_version: before.version + 2 }],
      ]);
      const audit = (await h.pool.query<{ details: Record<string, unknown> }>(
        `SELECT details FROM audit_log WHERE action = 'tag.suggestions_changed' AND actor_id = $1 ORDER BY id`, [admin.id])).rows;
      expect(audit.slice(-2).map((a) => a.details)).toEqual([{ suggestions_version: before.version + 1 }, { suggestions_version: before.version + 2 }]);
      expect(JSON.stringify(audit)).not.toContain(run);
    });

    it('rejects a stale If-Match with 412, other roles with 403, and invalid lists with 422 field paths', async () => {
      const now = await current();
      const stale = await as(admin).put('/tag-suggestions', { tags: [tag('قديم')] }, { 'If-Match': `"${now.version - 1}"` }).expect(412);
      expect(stale.body.code).toBe('precondition_failed');
      for (const a of [supervisor, chief, reporter]) {
        expect((await as(a).put('/tag-suggestions', { tags: [tag('دور')] }).expect(403)).body.code).toBe('forbidden_role');
      }
      const cases: Array<[unknown, string]> = [
        [[tag('مكرر'), tag('مكرر')], '/tags'],
        [Array.from({ length: 51 }, (_, i) => tag(`و${i}`)), '/tags'],
        [[` ${tag('مسافة')}`], '/tags/0'],
        [[`${tag('اتجاه')}\u202e`], '/tags/0'],
        [[''], '/tags/0'],
      ];
      for (const [tags, field] of cases) {
        const res = await as(admin).put('/tag-suggestions', { tags }).expect(422);
        expect(res.body.code).toBe('validation_failed');
        expect(res.body.details.fields).toContain(field);
      }
      expect((await current()).version).toBe(now.version);
    });
  });

  describe('usage', () => {
    it('counts materials per tag with the last use and the suggested position, most used first, filtered and paged', async () => {
      const [a, b, c] = [tag('خيمة'), tag('خيام'), tag('مقترح فقط')];
      await material([a, b]);
      await material([a]);
      await material([a, b]);
      await as(admin).put('/tag-suggestions', { tags: [c, a] }).expect(200);

      const all = await usage('');
      expect(all.items).toEqual([
        { tag: a, material_count: 3, last_used_at: expect.any(String), suggested_position: 2 },
        { tag: b, material_count: 2, last_used_at: expect.any(String), suggested_position: null },
        { tag: c, material_count: 0, last_used_at: null, suggested_position: 1 },
      ]);
      expect(all.next_cursor).toBeNull();
      const valid = schemaValidator('TagUsagePage');
      expect(valid(all) ? [] : valid.errors).toEqual([]);

      expect((await usage('&suggested=true')).items.map((i: { tag: string }) => i.tag)).toEqual([a, c]);
      expect((await usage('&suggested=false')).items.map((i: { tag: string }) => i.tag)).toEqual([b]);
      expect((await as(admin).get(`/tags?q=${encodeURIComponent(`خيام-${run}`)}`).expect(200)).body.items.map((i: { tag: string }) => i.tag)).toEqual([b]);

      const first = await usage('&limit=2');
      expect(first.items.map((i: { tag: string }) => i.tag)).toEqual([a, b]);
      const second = await usage(`&limit=2&cursor=${first.next_cursor}`);
      expect(second.items.map((i: { tag: string }) => i.tag)).toEqual([c]);
      expect(second.next_cursor).toBeNull();
    });

    it('is the admin’s alone, and a malformed cursor is 400', async () => {
      for (const a of [supervisor, chief, reporter]) expect((await as(a).get('/tags').expect(403)).body.code).toBe('forbidden_role');
      expect((await as(admin).get('/tags?cursor=bad').expect(400)).body.code).toBe('bad_request');
    });
  });

  describe('merge and rename', () => {
    it('renames a tag on every material in place, bumps the row version only, and logs the original with the materials it touched', async () => {
      const [from, to, other] = [tag('مياة'), tag('مياه'), tag('آخر')];
      const m1 = await material([other, from]);
      const m2 = await material([from]);
      const untouched = await material([other]);
      const before = await row(m1);
      const since = await lastEventId();

      const key = randomUUID();
      const res = await as(admin).post('/tag-rewrites', { source: from, target: to }, key).expect(201);
      expect(res.body).toMatchObject({ source: from, target: to, mode: 'rename', materials_updated: 2, created_by: admin.id });
      const valid = schemaValidator('TagRewrite');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      // التكرار بالمفتاح نفسه يعيد السجل نفسه بلا دمج ثانٍ
      expect((await as(admin).post('/tag-rewrites', { source: from, target: to }, key).expect(201)).body.id).toBe(res.body.id);

      const after = await row(m1);
      expect(after.tags).toEqual([other, to]);
      expect(Number(after.row_version)).toBeGreaterThan(Number(before.row_version));
      expect(after).toMatchObject({ version: before.version, technical_state: before.technical_state, editorial_state: before.editorial_state, rights_state: before.rights_state });
      expect((await row(m2)).tags).toEqual([to]);
      expect((await row(untouched)).tags).toEqual([other]);

      const log = await h.pool.query(`SELECT source, target, mode, materials_updated FROM tag_rewrites WHERE id = $1`, [res.body.id]);
      expect(log.rows).toEqual([{ source: from, target: to, mode: 'rename', materials_updated: 2 }]);
      const touched = await h.pool.query<{ material_id: string }>(`SELECT material_id FROM tag_rewrite_materials WHERE tag_rewrite_id = $1 ORDER BY material_id`, [res.body.id]);
      expect(touched.rows.map((r) => r.material_id)).toEqual([m1, m2].sort());
      await expect(h.pool.query(`UPDATE tag_rewrites SET target = 'x' WHERE id = $1`, [res.body.id])).rejects.toThrow(/append-only/);

      const events = await eventsSince(since);
      expect(events.map((e) => [e.type, e.aggregate_type, e.aggregate_id, e.payload])).toEqual([
        ['tag.rewritten', 'user', admin.id, { tag_rewrite_id: res.body.id, mode: 'rename', materials_updated: 2 }],
      ]);
      const audit = (await h.pool.query<{ details: Record<string, unknown>; target_type: string }>(
        `SELECT details, target_type FROM audit_log WHERE action = 'tag.rewritten' AND target_id = $1`, [res.body.id])).rows;
      expect(audit).toEqual([{ target_type: 'tag_rewrite', details: { tag_rewrite_id: res.body.id, mode: 'rename', materials_updated: 2 } }]);
      // لا نص وسم في حدث ولا تدقيق ولا إشعار
      expect(JSON.stringify(events) + JSON.stringify(audit)).not.toContain(run);
      const notes = await h.pool.query(`SELECT title FROM notifications WHERE title LIKE $1`, [`%${run}%`]);
      expect(notes.rows).toEqual([]);
    });

    it('merges into a tag a material already holds without duplicating it, and rewrites the suggested list in place', async () => {
      const [from, to, keep] = [tag('دمج-أصل'), tag('دمج-هدف'), tag('دمج-ثابت')];
      const both = await material([from, keep, to]);
      const targetFirst = await material([to, from]);
      await as(admin).put('/tag-suggestions', { tags: [keep, from] }).expect(200);
      const list = await current();

      const res = await as(admin).post('/tag-rewrites', { source: from, target: to }).expect(201);
      expect(res.body).toMatchObject({ mode: 'merge', materials_updated: 2 });
      expect((await row(both)).tags).toEqual([to, keep]);
      expect((await row(targetFirst)).tags).toEqual([to]);
      const after = await current();
      expect(after).toMatchObject({ tags: [keep, to], version: list.version + 1 });

      // الهدف في القائمة أصلًا: يُحذف الأصل منها وحده
      const [s1, s2] = [tag('مقترح-أ'), tag('مقترح-ب')];
      await as(admin).put('/tag-suggestions', { tags: [s1, s2] }).expect(200);
      const onlyList = await as(admin).post('/tag-rewrites', { source: s1, target: s2 }).expect(201);
      expect(onlyList.body).toMatchObject({ mode: 'merge', materials_updated: 0 });
      expect((await current()).tags).toEqual([s2]);
    });

    it('is 404 for a tag that is nowhere, 422 for the same tag or an invalid one, and 403 for other roles', async () => {
      expect((await as(admin).post('/tag-rewrites', { source: tag('غائب'), target: tag('هدف') }).expect(404)).body.code).toBe('not_found');
      const same = await as(admin).post('/tag-rewrites', { source: tag('نفسه'), target: tag('نفسه') }).expect(422);
      expect(same.body.details.fields).toEqual(['/target']);
      const invalid = await as(admin).post('/tag-rewrites', { source: tag('صالح'), target: ` ${tag('مسافة')}` }).expect(422);
      expect(invalid.body.code).toBe('validation_failed');
      for (const a of [supervisor, chief, reporter]) {
        expect((await as(a).post('/tag-rewrites', { source: tag('أ'), target: tag('ب') }).expect(403)).body.code).toBe('forbidden_role');
      }
    });
  });
});
