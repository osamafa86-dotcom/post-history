import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { MaterialsService } from '../../src/materials/materials.service';
import { createHarness, currentFormVersion, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

describe('materials (/v1/materials)', () => {
  let h: Harness;
  let formVersion: number;
  let officeA: string;
  let officeB: string;
  let reporterA: Actor;
  let reporterB: Actor;
  let supervisorA: Actor;
  let supervisorGaza: Actor;
  let producer: Actor;
  let producer2: Actor;
  let editor: Actor;
  let rights: Actor;
  let finance: Actor;

  beforeAll(async () => {
    h = await createHarness();
    formVersion = (await currentFormVersion(h)) + 1;
    await h.pool.query(`INSERT INTO upload_forms (version, schema) VALUES ($1, $2)`, [
      formVersion,
      {
        version: formVersion,
        fields: [
          { key: 'notes', type: 'long_text', label: { ar: 'م', en: 'Notes' }, required: false, validation: { max_length: 20 } },
          { key: 'guest_name', type: 'short_text', label: { ar: 'م', en: 'Guest' }, required: true, material_types: ['interview'] },
        ],
      },
    ]);
    const office = async (gov: string) =>
      (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en, governorate) VALUES ('م', 'o', $1) RETURNING id`, [gov]))
        .rows[0]!.id;
    officeA = await office('gaza');
    officeB = await office('khan_younis');
    reporterA = await loginAs(h, [{ role: 'reporter' }], { officeId: officeA });
    reporterB = await loginAs(h, [{ role: 'reporter' }], { officeId: officeB });
    supervisorA = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeA }]);
    supervisorGaza = await loginAs(h, [{ role: 'supervisor', scopeKind: 'governorate', scopeId: 'gaza' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    producer2 = await loginAs(h, [{ role: 'producer' }]);
    editor = await loginAs(h, [{ role: 'editor_in_chief' }]);
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${a.token}`),
    write: (method: 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) =>
      http()[method](url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body),
  });

  const createBody = (over: object = {}) => ({
    title: 'Press conference at noon',
    material_types: ['report'],
    governorate: 'gaza',
    city: 'gaza',
    priority: 'normal',
    sensitivity: { minors: false, injured: false, graphic: false },
    display_name: { mode: 'network' },
    form_version: formVersion,
    dynamic_fields: { notes: 'short' },
    ...over,
  });
  const create = async (a: Actor = reporterA, over: object = {}) => (await as(a).write('post', '/v1/materials', createBody(over)).expect(201)).body;
  const events = async (id: string) =>
    (await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [id])).rows;
  const setEditorial = (id: string, state: string) => h.pool.query(`UPDATE materials SET editorial_state = $2 WHERE id = $1`, [id, state]);

  describe('create', () => {
    it('creates with initial states, default contributor, events, and never returns gps', async () => {
      const m = await create(reporterA, { priority: 'urgent', gps: { lat: 31.5, lng: 34.46 } });
      expect(m).toMatchObject({
        reporter_id: reporterA.id,
        office_id: officeA,
        technical_state: 'pending',
        editorial_state: 'inbox',
        rights_state: 'unknown',
        version: 1,
        contributors: [{ user_id: reporterA.id, role: 'reporter', share_percent: 100 }],
        dynamic_fields: { notes: 'short' },
        redacted_field_keys: [],
        files: [],
      });
      const valid = schemaValidator('Material');
      expect(valid(m) ? [] : valid.errors).toEqual([]);
      expect(m).not.toHaveProperty('gps');
      expect(JSON.stringify(m)).not.toContain('31.5');
      const { rows } = await h.pool.query(`SELECT gps_enc FROM materials WHERE id = $1`, [m.id]);
      expect(rows[0].gps_enc).toBeInstanceOf(Buffer);
      expect(rows[0].gps_enc.toString()).not.toContain('31.5');
      expect((await events(m.id)).map((e) => e.type)).toEqual(['material.created', 'material.urgent_received']);
    });

    it('validates dynamic fields with the form version (422 dynamic_fields_invalid) and drops hidden values', async () => {
      const bad = await as(reporterA)
        .write('post', '/v1/materials', createBody({ material_types: ['interview'], dynamic_fields: { notes: 'x'.repeat(21) } }))
        .expect(422);
      expect(bad.body.code).toBe('dynamic_fields_invalid');
      expect(bad.body.details.errors).toEqual([
        { field: 'notes', code: 'max_length' },
        { field: 'guest_name', code: 'required' },
      ]);
      // guest_name مخفي لنوع report: يُتجاهل ولا يُحفظ
      const m = await create(reporterA, { dynamic_fields: { notes: 'ok', guest_name: 123 } });
      expect(m.dynamic_fields).toEqual({ notes: 'ok' });
      await as(reporterA).write('post', '/v1/materials', createBody({ form_version: 999999 })).expect(422);
    });

    it('requires contributor shares to sum to exactly 100 (422 shares_not_100)', async () => {
      const res = await as(reporterA)
        .write('post', '/v1/materials', createBody({ contributors: [{ user_id: reporterA.id, role: 'photographer', share_percent: 99.99 }] }))
        .expect(422);
      expect(res.body.code).toBe('shares_not_100');
      const ok = await create(reporterA, {
        contributors: [
          { user_id: reporterA.id, role: 'photographer', share_percent: 33.33 },
          { user_id: reporterB.id, role: 'fixer', share_percent: 66.67 },
        ],
      });
      expect(ok.contributors).toHaveLength(2);
    });

    it('only reporters create; roles outside x-roles get 403 before any lookup', async () => {
      expect((await as(producer).write('post', '/v1/materials', createBody()).expect(403)).body.code).toBe('forbidden_scope');
      await as(finance).get('/v1/materials').expect(403);
      await as(finance).get(`/v1/materials/${randomUUID()}`).expect(403);
    });
  });

  describe('scope (enforced in the query layer)', () => {
    let mA: { id: string };
    let mB: { id: string };
    beforeAll(async () => {
      mA = await create(reporterA);
      mB = await create(reporterB);
    });

    it('reporters see only their own materials; others are 404', async () => {
      await as(reporterA).get(`/v1/materials/${mA.id}`).expect(200);
      await as(reporterA).get(`/v1/materials/${mB.id}`).expect(404);
      const list = await as(reporterA).get('/v1/materials?limit=100').expect(200);
      expect(list.body.items.every((m: { reporter_id: string }) => m.reporter_id === reporterA.id)).toBe(true);
    });

    it('supervisors see their office or their governorate; not others', async () => {
      await as(supervisorA).get(`/v1/materials/${mA.id}`).expect(200);
      await as(supervisorA).get(`/v1/materials/${mB.id}`).expect(404);
      await as(supervisorGaza).get(`/v1/materials/${mA.id}`).expect(200);
      await as(supervisorGaza).get(`/v1/materials/${mB.id}`).expect(404);
    });

    it('producers see accepted-and-later materials only; editors and rights officers see all', async () => {
      await as(producer).get(`/v1/materials/${mA.id}`).expect(404);
      await setEditorial(mA.id, 'accepted');
      await as(producer).get(`/v1/materials/${mA.id}`).expect(200);
      await setEditorial(mA.id, 'inbox');
      await as(editor).get(`/v1/materials/${mB.id}`).expect(200);
      await as(rights).get(`/v1/materials/${mB.id}`).expect(200);
    });

    it('paginates newest first with an opaque cursor and validates query parameters', async () => {
      for (let i = 0; i < 3; i++) await create(reporterB);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const url: string = `/v1/materials?limit=2&reporter_id=${reporterB.id}${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await as(editor).get(url).expect(200);
        seen.push(...res.body.items.map((m: { id: string }) => m.id));
        cursor = res.body.next_cursor;
      } while (cursor);
      const { rows } = await h.pool.query(`SELECT id FROM materials WHERE reporter_id = $1 ORDER BY created_at DESC, id DESC`, [reporterB.id]);
      expect(seen).toEqual(rows.map((r) => r.id));
      await as(editor).get('/v1/materials?cursor=not-a-cursor').expect(400);
      await as(editor).get('/v1/materials?editorial_state=bogus').expect(400);
      await as(editor).get('/v1/materials?limit=500').expect(400);
      await as(editor).get('/v1/materials?unknown=1').expect(400);
    });
  });

  describe('transitions', () => {
    it('supervisor acknowledges within scope: record, track event and semantic event', async () => {
      const m = await create(reporterA);
      const res = await as(supervisorA)
        .write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'acknowledged', reason: 'seen', note_timecode_ms: 42000 })
        .expect(200);
      expect(res.body.editorial_state).toBe('acknowledged');
      const log = await as(reporterA).get(`/v1/materials/${m.id}/transitions`).expect(200);
      expect(log.body.items).toEqual([
        expect.objectContaining({ track: 'editorial', from: 'inbox', to: 'acknowledged', reason: 'seen', actor_id: supervisorA.id, note_timecode_ms: 42000 }),
      ]);
      const ev = await events(m.id);
      expect(ev.map((e) => e.type)).toEqual(['material.created', 'material.editorial_transition', 'material.acknowledged']);
      expect(ev[1].payload).toEqual({
        material_id: m.id,
        priority: 'normal',
        office_id: officeA,
        track: 'editorial',
        from: 'inbox',
        to: 'acknowledged',
        note_timecode_ms: 42000,
      });
    });

    it('rejects transitions outside the table with 409 invalid_transition and details', async () => {
      const m = await create(reporterA);
      const res = await as(supervisorA)
        .write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'published', reason: 'x' })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'invalid_transition', details: { track: 'editorial', from: 'inbox', to: 'published' } });
      await as(supervisorA).write('post', `/v1/materials/${m.id}/transitions`, { track: 'rights', to: 'nonsense', reason: 'x' }).expect(409);
    });

    it('enforces the owner of each transition (403) and scope (404)', async () => {
      const m = await create(reporterA);
      // المراسل لا يعتمد
      await as(reporterA).write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'acknowledged', reason: 'x' }).expect(403);
      // الانتقالات الفنية للخادم
      await as(editor).write('post', `/v1/materials/${m.id}/transitions`, { track: 'technical', to: 'proxy_received', reason: 'x' }).expect(403);
      // مشرف خارج النطاق لا يرى المادة
      const other = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: officeB }]);
      await as(other).write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'acknowledged', reason: 'x' }).expect(404);
      // مسؤول الحقوق يوثق
      await as(rights).write('post', `/v1/materials/${m.id}/transitions`, { track: 'rights', to: 'documented', reason: 'contract on file' }).expect(200);
      // accepted → in_production عبر الحجز لا الانتقالات
      await setEditorial(m.id, 'accepted');
      const viaTransition = await as(producer)
        .write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'in_production', reason: 'x' })
        .expect(403);
      expect(viaTransition.body.message).toContain('reservation');
    });

    it('the reporter answers a change request and retries a failed upload', async () => {
      const m = await create(reporterA);
      await setEditorial(m.id, 'needs_changes');
      await as(reporterA).write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'reviewing', reason: 'fixed' }).expect(200);
      await h.pool.query(`UPDATE materials SET technical_state = 'failed' WHERE id = $1`, [m.id]);
      await as(reporterA).write('post', `/v1/materials/${m.id}/transitions`, { track: 'technical', to: 'pending', reason: 'retry' }).expect(200);
    });
  });

  describe('edit (PATCH)', () => {
    it('editing before approval keeps the version and emits material.updated', async () => {
      const m = await create(reporterA);
      const res = await as(reporterA).write('patch', `/v1/materials/${m.id}`, { title: 'A better title here' }).expect(200);
      expect(res.body).toMatchObject({ title: 'A better title here', version: 1, editorial_state: 'inbox' });
      expect((await events(m.id)).map((e) => e.type)).toContain('material.updated');
    });

    it('editing an approved version bumps version and returns it to final_review', async () => {
      const m = await create(reporterA);
      await setEditorial(m.id, 'published');
      const res = await as(editor).write('patch', `/v1/materials/${m.id}`, { city: 'rafah' }).expect(200);
      expect(res.body).toMatchObject({ version: 2, editorial_state: 'final_review', city: 'rafah' });
      const log = await as(editor).get(`/v1/materials/${m.id}/transitions`).expect(200);
      expect(log.body.items.at(-1)).toMatchObject({ from: 'published', to: 'final_review' });
      expect((await events(m.id)).map((e) => e.type)).toEqual(
        expect.arrayContaining(['material.editorial_transition', 'material.version_created']),
      );
    });

    it('revalidates dynamic fields when they or the form version change; others cannot edit', async () => {
      const m = await create(reporterA);
      const res = await as(reporterA).write('patch', `/v1/materials/${m.id}`, { material_types: ['interview'] }).expect(422);
      expect(res.body.details.errors).toEqual([{ field: 'guest_name', code: 'required' }]);
      await as(reporterA)
        .write('patch', `/v1/materials/${m.id}`, { material_types: ['interview'], dynamic_fields: { guest_name: 'Spokesperson' } })
        .expect(200);
      await as(reporterB).write('patch', `/v1/materials/${m.id}`, { city: 'x' }).expect(404);
      await as(producer).write('patch', `/v1/materials/${m.id}`, { city: 'x' }).expect(403);
    });
  });

  describe('contributors', () => {
    it('rights officer replaces contributors; the sum must be exactly 100', async () => {
      const m = await create(reporterA);
      const ok = await as(rights)
        .write('put', `/v1/materials/${m.id}/contributors`, {
          contributors: [
            { user_id: reporterA.id, role: 'reporter', share_percent: 50 },
            { user_id: reporterB.id, role: 'photographer', share_percent: 50 },
          ],
        })
        .expect(200);
      expect(ok.body.contributors).toHaveLength(2);
      const bad = await as(rights)
        .write('put', `/v1/materials/${m.id}/contributors`, { contributors: [{ user_id: reporterA.id, role: 'reporter', share_percent: 60 }] })
        .expect(422);
      expect(bad.body.code).toBe('shares_not_100');
      await as(rights)
        .write('put', `/v1/materials/${m.id}/contributors`, { contributors: [{ user_id: randomUUID(), role: 'reporter', share_percent: 100 }] })
        .expect(422);
      await as(reporterA)
        .write('put', `/v1/materials/${m.id}/contributors`, { contributors: [{ user_id: reporterA.id, role: 'reporter', share_percent: 100 }] })
        .expect(403);
      expect((await events(m.id)).map((e) => e.type)).toContain('material.contributors_set');
    });
  });

  describe('reservation', () => {
    it('reserves an accepted material, blocks a second producer, renews, and releases', async () => {
      const m = await create(reporterA);
      await setEditorial(m.id, 'accepted');
      const r = await as(producer).write('post', `/v1/materials/${m.id}/reservation`).expect(200);
      expect(r.body).toMatchObject({ material_id: m.id, reserved_by: producer.id });
      expect(Date.parse(r.body.releases_at) - Date.parse(r.body.reserved_at)).toBe(15 * 60 * 1000);
      const after = await as(producer).get(`/v1/materials/${m.id}`).expect(200);
      expect(after.body).toMatchObject({ editorial_state: 'in_production', reserved_by: producer.id });

      expect((await as(producer2).write('post', `/v1/materials/${m.id}/reservation`).expect(409)).body.code).toBe('already_reserved');
      await as(producer).write('post', `/v1/materials/${m.id}/reservation`).expect(200);
      await as(producer2).write('delete', `/v1/materials/${m.id}/reservation`).expect(403);
      // صاحب الحجز ينقل إلى المراجعة النهائية
      await as(producer).write('post', `/v1/materials/${m.id}/transitions`, { track: 'editorial', to: 'final_review', reason: 'cut done' }).expect(200);
      await as(producer).write('delete', `/v1/materials/${m.id}/reservation`).expect(204);
      await as(producer).write('delete', `/v1/materials/${m.id}/reservation`).expect(204);
      const types = (await events(m.id)).map((e) => e.type);
      expect(types.filter((t) => t === 'material.reserved')).toHaveLength(1);
      expect(types).toContain('material.released');
    });

    it('an idle reservation is free to take over and is released by the sweep', async () => {
      const m = await create(reporterA);
      await setEditorial(m.id, 'accepted');
      await as(producer).write('post', `/v1/materials/${m.id}/reservation`).expect(200);
      await h.pool.query(`UPDATE materials SET reserved_at = now() - interval '16 minutes' WHERE id = $1`, [m.id]);
      expect((await as(producer).get(`/v1/materials/${m.id}`).expect(200)).body.reserved_by).toBeNull();
      await h.app.get(MaterialsService).releaseIdleReservations();
      const { rows } = await h.pool.query(`SELECT reserved_by FROM materials WHERE id = $1`, [m.id]);
      expect(rows[0].reserved_by).toBeNull();
      await as(producer2).write('post', `/v1/materials/${m.id}/reservation`).expect(200);
    });

    it('only accepted or in-production materials can be reserved; supervisors cannot reserve', async () => {
      const m = await create(reporterA);
      await as(editor).write('post', `/v1/materials/${m.id}/reservation`).expect(409);
      await as(supervisorA).write('post', `/v1/materials/${m.id}/reservation`).expect(403);
    });
  });
});
