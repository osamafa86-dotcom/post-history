import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { DB, type Database } from '../../src/database/database.module';
import { writeOutboxEvent } from '../../src/outbox/outbox';
import { createHarness, currentFormVersion, drainOutbox, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

// وسوم المادة (ADR 0086): تُحفظ وتُعاد بترتيبها في Material، ولا تدخل Outbox ولا إشعارًا ولا الكتالوج
describe('material tags (/v1/materials)', () => {
  let h: Harness;
  let formVersion: number;
  let officeA: string;
  let officeB: string;
  let reporterA: Actor;
  let reporterB: Actor;
  let supervisorA: Actor;
  let supervisorB: Actor;
  let supervisorGaza: Actor;
  let editor: Actor;
  let rights: Actor;
  let admin: Actor;
  let finance: Actor;

  beforeAll(async () => {
    h = await createHarness();
    formVersion = (await currentFormVersion(h)) + 1;
    await h.pool.query(`INSERT INTO upload_forms (version, schema) VALUES ($1, $2)`, [formVersion, { version: formVersion, fields: [] }]);
    const office = async (gov: string) =>
      (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', $1) RETURNING id`, [gov])).rows[0]!.id;
    officeA = await office('gaza');
    officeB = await office('khan_younis');
    reporterA = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
    reporterB = await loginAs(h, [{ role: 'reporter' }], { officeId: officeB });
    supervisorA = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
    supervisorB = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
    supervisorGaza = await loginAs(h, [{ role: 'supervisor', scopeKind: 'governorate', scopeId: 'gaza' }]);
    editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${a.token}`),
    write: (method: 'post' | 'patch' | 'put', url: string, body?: object) =>
      http()[method](url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body),
  });

  const createBody = (over: object = {}) => ({
    title: 'Convoy arrives at the crossing',
    material_types: ['report'],
    governorate: 'gaza',
    city: 'gaza',
    priority: 'normal',
    sensitivity: { minors: false, injured: false, graphic: false },
    display_name: { mode: 'network' },
    form_version: formVersion,
    dynamic_fields: {},
    ...over,
  });
  const create = async (a: Actor = reporterA, over: object = {}) => (await as(a).write('post', '/v1/materials', createBody(over)).expect(201)).body;
  const dbTags = async (id: string) => (await h.pool.query<{ tags: string[] }>(`SELECT tags FROM materials WHERE id = $1`, [id])).rows[0]!.tags;
  const setEditorial = (id: string, state: string) => h.pool.query(`UPDATE materials SET editorial_state = $2 WHERE id = $1`, [id, state]);

  // بترتيب غير أبجدي عمدًا، وفيها ما يكسر تسلسل مصفوفة Postgres لو لم يُهرَّب: فاصلة وأقواس وعلامة اقتباس وشرطة مائلة، و«NULL» نصًّا،
  // ورموز خارج المستوى الأساسي (40 نقطة ترميز = 80 وحدة UTF-16) فيتفق عدّ العقد وعدّ القاعدة
  const TAGS = ['زيت', 'Aid convoy', 'a,b', '"quoted"', 'back\\slash', '{braces}', 'NULL', '🔥'.repeat(40), 'مساعدات'];

  describe('create', () => {
    it('stores the tags and reads them back in the same order from create, get and the list', async () => {
      const created = await create(reporterA, { tags: TAGS });
      expect(created.tags).toEqual(TAGS);
      const valid = schemaValidator('Material');
      expect(valid(created) ? [] : valid.errors).toEqual([]);
      expect(await dbTags(created.id)).toEqual(TAGS);

      expect((await as(reporterA).get(`/v1/materials/${created.id}`).expect(200)).body.tags).toEqual(TAGS);
      const list = await as(editor).get(`/v1/materials?reporter_id=${reporterA.id}&limit=100`).expect(200);
      expect(list.body.items.find((m: { id: string }) => m.id === created.id).tags).toEqual(TAGS);
    });

    it('a material created without tags returns an empty array, not a missing key or null; an explicit empty array is the same', async () => {
      const absent = await create();
      expect(absent.tags).toEqual([]);
      expect((await as(reporterA).get(`/v1/materials/${absent.id}`).expect(200)).body.tags).toEqual([]);
      expect(await dbTags(absent.id)).toEqual([]);
      expect((await create(reporterA, { tags: [] })).tags).toEqual([]);
    });
  });

  describe('edit (PATCH)', () => {
    it('present tags replace the whole list in the order given, an empty array clears it, and the row version moves', async () => {
      const m = await create(reporterA, { tags: ['a1', 'b2', 'c3'] });
      const before = (await h.pool.query<{ row_version: string }>(`SELECT row_version FROM materials WHERE id = $1`, [m.id])).rows[0]!.row_version;

      const replaced = await as(reporterA).write('patch', `/v1/materials/${m.id}`, { tags: ['c3', 'x9'] }).expect(200);
      expect(replaced.body.tags).toEqual(['c3', 'x9']);
      expect(replaced.body).toMatchObject({ title: m.title, version: 1, editorial_state: 'inbox' });
      expect(await dbTags(m.id)).toEqual(['c3', 'x9']);
      const after = (await h.pool.query<{ row_version: string }>(`SELECT row_version FROM materials WHERE id = $1`, [m.id])).rows[0]!.row_version;
      expect(Number(after)).toBeGreaterThan(Number(before));
      const types = (await h.pool.query<{ type: string }>(`SELECT type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [m.id])).rows.map((e) => e.type);
      expect(types).toContain('material.updated');

      const cleared = await as(reporterA).write('patch', `/v1/materials/${m.id}`, { tags: [] }).expect(200);
      expect(cleared.body.tags).toEqual([]);
      expect(await dbTags(m.id)).toEqual([]);
    });

    it('a patch without tags keeps them, also on an approved version that moves to a new version', async () => {
      const m = await create(reporterA, { tags: ['keep-1', 'keep-2'] });
      const kept = await as(reporterA).write('patch', `/v1/materials/${m.id}`, { title: 'A better title here' }).expect(200);
      expect(kept.body).toMatchObject({ title: 'A better title here', tags: ['keep-1', 'keep-2'] });
      expect((await as(reporterA).get(`/v1/materials/${m.id}`).expect(200)).body.tags).toEqual(['keep-1', 'keep-2']);

      await setEditorial(m.id, 'published');
      const approved = await as(editor).write('patch', `/v1/materials/${m.id}`, { city: 'rafah' }).expect(200);
      expect(approved.body).toMatchObject({ version: 2, editorial_state: 'final_review', tags: ['keep-1', 'keep-2'] });
    });
  });

  describe('invalid tags: 422 validation_failed with field paths only, never the values', () => {
    const secret = `سري-${randomUUID().slice(0, 8)}`;
    const cases: Array<[string, unknown, string[]]> = [
      ['more than 12 tags', Array.from({ length: 13 }, (_, i) => `${secret}-${i}`), ['/tags']],
      ['a duplicate', [secret, 'other', secret], ['/tags']],
      ['an empty tag', [''], ['/tags/0']],
      ['a tag over 40 characters', [secret.padEnd(41, 'x')], ['/tags/0']],
      ['a leading space', [` ${secret}`], ['/tags/0']],
      ['a trailing no-break space', ['fine', `${secret}\u00a0`], ['/tags/1']],
      ['a control character', [`${secret}\u0007`], ['/tags/0']],
      ['a bidi control character', [`${secret}\u202e`], ['/tags/0']],
      ['a non-string item', [secret, 7], ['/tags/1']],
      ['a value that is not an array', secret, ['/tags']],
    ];

    it.each(cases)('POST with %s is rejected and nothing is stored', async (_name, tags, fields) => {
      const title = `Rejected tags ${randomUUID()}`;
      const res = await as(reporterA).write('post', '/v1/materials', createBody({ title, tags })).expect(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details).toEqual({ fields });
      expect(JSON.stringify(res.body)).not.toContain(secret);
      expect((await h.pool.query(`SELECT 1 FROM materials WHERE title = $1`, [title])).rowCount).toBe(0);
    });

    it.each(cases)('PATCH with %s is rejected and neither the tags nor the other fields in the request change', async (_name, tags, fields) => {
      const m = await create(reporterA, { tags: ['keep-1'] });
      const res = await as(reporterA).write('patch', `/v1/materials/${m.id}`, { title: 'Changed together with bad tags', tags }).expect(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.details).toEqual({ fields });
      expect(JSON.stringify(res.body)).not.toContain(secret);
      const now = (await as(reporterA).get(`/v1/materials/${m.id}`).expect(200)).body;
      expect(now).toMatchObject({ title: m.title, tags: ['keep-1'] });
    });
  });

  describe('scope (the existing query-layer scoping covers tags)', () => {
    it("another office's reporter and supervisor cannot read, list or edit them; the owner's office, its governorate and the editor can", async () => {
      const sentinel = randomBytes(6).toString('hex');
      const own = [`خاص-${sentinel}`, `private-${sentinel}`];
      const m = await create(reporterA, { tags: own });

      for (const outsider of [reporterB, supervisorB]) {
        await as(outsider).get(`/v1/materials/${m.id}`).expect(404);
        await as(outsider).write('patch', `/v1/materials/${m.id}`, { tags: ['hijacked'] }).expect(404);
        const list = await as(outsider).get('/v1/materials?limit=100').expect(200);
        expect(JSON.stringify(list.body)).not.toContain(sentinel);
      }
      expect(await dbTags(m.id)).toEqual(own);

      for (const insider of [reporterA, supervisorA, supervisorGaza, editor]) {
        expect((await as(insider).get(`/v1/materials/${m.id}`).expect(200)).body.tags).toEqual(own);
      }
    });
  });

  describe('tags stay out of events, notifications, audit and the catalog (ADR 0086)', () => {
    it('no outbox payload, inbox notification, audit row or /events item carries a tag or a tags key, through create, edits, approval and listing', async () => {
      const sentinel = randomBytes(6).toString('hex');
      const first = [`خاص-${sentinel}`, `private-${sentinel}`];
      const second = [`اسم-${sentinel}-2`];
      const { rows: mark } = await h.pool.query<{ id: string }>(`SELECT coalesce(max(id), 0)::text AS id FROM outbox_events`);

      // عاجلة: حدثان للمادة وإشعار للمشرف. ثم تعديلان (وسوم جديدة وبلا وسوم) وانتقال، ثم اعتماد وتعديل بعده فينشأ إصدار
      const m = await create(reporterA, { priority: 'urgent', tags: first });
      await as(reporterA).write('patch', `/v1/materials/${m.id}`, { tags: second }).expect(200);
      await as(reporterA).write('patch', `/v1/materials/${m.id}`, { title: 'Retitled convoy arrival' }).expect(200);
      await as(supervisorA).write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'acknowledged', reason: 'seen' }).expect(200);
      await setEditorial(m.id, 'published');
      await as(editor).write('patch', `/v1/materials/${m.id}`, { tags: [...second, ...first], city: 'rafah' }).expect(200);
      await drainOutbox(h);

      const { rows: events } = await h.pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`,
        [m.id],
      );
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['material.created', 'material.urgent_received', 'material.updated', 'material.version_created']));
      for (const e of events) {
        expect([e.type, Object.keys(e.payload).includes('tags')]).toEqual([e.type, false]);
        expect([e.type, JSON.stringify(e.payload).includes(sentinel)]).toEqual([e.type, false]);
      }
      // مسح شامل لا ينتظر شكل الحدث: لا صف في Outbox كله يحمل القيمة
      const leaks = async (table: string) =>
        (await h.pool.query(`SELECT 1 FROM ${table} t WHERE to_jsonb(t)::text LIKE $1`, [`%${sentinel}%`])).rowCount;
      expect(await leaks('outbox_events')).toBe(0);
      expect(await leaks('audit_log')).toBe(0);
      expect(await leaks('notifications')).toBe(0);
      expect(await leaks('notification_deliveries')).toBe(0);
      // ليس مسحًا فارغًا: للمادة إشعارات فعلًا
      expect((await h.pool.query(`SELECT 1 FROM notifications WHERE material_id = $1`, [m.id])).rowCount).toBeGreaterThan(0);
      const inbox = await as(supervisorA).get('/v1/notifications?limit=100').expect(200);
      expect(JSON.stringify(inbox.body)).not.toContain(sentinel);

      const feed = await as(admin).get(`/v1/events?after=${mark[0]!.id}&limit=100`).expect(200);
      expect(feed.body.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(feed.body)).not.toContain(sentinel);

      // وقيد القاعدة يحرس ما وراء الكود: حدث للمادة بمفتاح tags يُرفض
      await expect(
        h.app.get<Database>(DB).transaction((tx) =>
          writeOutboxEvent(tx, {
            type: 'material.updated',
            aggregateType: 'material',
            aggregateId: m.id,
            idempotencyKey: `material.updated:${m.id}:tags-probe`,
            payload: { material_id: m.id, tags: second },
          }),
        ),
      ).rejects.toThrow();
    });

    it('a listed material shows no tag in /catalog: not in the list, not in the item, not searchable by a tag', async () => {
      const sentinel = randomBytes(6).toString('hex');
      const m = await create(reporterA, { shot_at: '2026-10-20T10:00:00Z', tags: [`خاص-${sentinel}`, `private-${sentinel}`] });
      const template = (
        await as(admin)
          .write('post', '/v1/license-templates', {
            type: 'editorial_single',
            name: { ar: 'ترخيص', en: 'License' },
            terms: { ar: 'ش', en: 'Terms' },
            usage_media: ['web'],
            territory: { kind: 'worldwide' },
            term_days: null,
            exclusivity_hours: null,
            deliverables: ['original'],
            attribution: { ar: 'ن', en: 'A' },
            prohibitions: [],
            base_price: { amount_minor: 5000, currency: 'USD' },
            enabled: true,
          })
          .expect(201)
      ).body.id as string;
      // قابلة للبيع بأصل متحقق منه، ثم إدراجها معروضةً
      await h.pool.query(`UPDATE materials SET rights_state = 'sellable' WHERE id = $1`, [m.id]);
      const { rows: file } = await h.pool.query<{ id: string }>(
        `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, duration_ms, width, height)
         VALUES ($1, 'original', 'received', 5000, $2, $3, 60000, 1920, 1080) RETURNING id`,
        [m.id, randomBytes(32), `tus/${randomUUID()}`],
      );
      await h.pool.query(`UPDATE material_files SET state = 'verified', verified_at = now() WHERE id = $1`, [file[0]!.id]);
      // كلمة العنوان غير قيمة الوسم، فوجود الوسم في أي مكان من الاستجابة تسرّب لا اقتباس
      const word = `convoy${randomBytes(6).toString('hex')}`;
      const listing = (
        await as(rights)
          .write('post', `/v1/materials/${m.id}/listing`, {
            title: { ar: `قافلة ${word}`, en: `Convoy ${word}` },
            description: { ar: 'وصف', en: 'Description' },
            shot_list: [{ start_ms: 0, label: { ar: 'لقطة', en: 'Shot' } }],
            offers: [{ license_template_id: template, price_override: { amount_minor: 4200, currency: 'ILS' } }],
            state: 'listed',
          })
          .expect(201)
      ).body;

      // العنصر نفسه موجود ويُعثر عليه بعنوانه، فغياب الوسم عنه ليس غياب العنصر
      const byTitle = await as(finance).get(`/v1/catalog?q=${word}&limit=100`).expect(200);
      expect(byTitle.body.items.map((i: { listing_id: string }) => i.listing_id)).toEqual([listing.id]);
      const item = (await as(finance).get(`/v1/catalog/${listing.id}`).expect(200)).body;
      expect(Object.keys(item)).not.toContain('tags');
      expect(JSON.stringify(item)).not.toContain(sentinel);
      expect(JSON.stringify(byTitle.body)).not.toContain(sentinel);
      const all = await as(finance).get('/v1/catalog?limit=100').expect(200);
      expect(JSON.stringify(all.body)).not.toContain(sentinel);
      // والبحث النصي لا يطال الوسوم (فهرسة البحث بالوسم قرار لاحق)
      expect((await as(finance).get(`/v1/catalog?q=private-${sentinel}&limit=100`).expect(200)).body.items).toEqual([]);

      // المادة نفسها تحتفظ بوسومها لمن يقرؤها
      expect((await as(editor).get(`/v1/materials/${m.id}`).expect(200)).body.tags).toEqual([`خاص-${sentinel}`, `private-${sentinel}`]);
    });
  });
});
