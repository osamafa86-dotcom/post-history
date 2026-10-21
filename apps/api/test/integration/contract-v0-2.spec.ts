import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { fieldKeyring } from '../../src/config/config';
import { EscalationWorker } from '../../src/notifications/escalation.worker';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

/** تخزين بديل يوقّع روابط وهمية ويعرف أحجام كائنات المشتقات. */
class FakeStorage implements ObjectStorage {
  sizes = new Map<string, number>();
  async head(_bucket: string, key: string) {
    const size = this.sizes.get(key);
    return size === undefined ? null : { size };
  }
  async read(): Promise<never> {
    throw new Error('not used');
  }
  presignGet(bucket: string, key: string): string {
    return `https://storage.test/${bucket}/${key}?X-Amz-Expires=600`;
  }
}

const hex = (b: Buffer) => b.toString('hex');

describe('contract v0.2 on the server', () => {
  const storage = new FakeStorage();
  const workerToken = randomBytes(32).toString('base64url');
  let h: Harness;
  let office: string;
  let otherOffice: string;
  let admin: Actor;
  let chief: Actor;
  let supervisor: Actor;
  let otherSupervisor: Actor;
  let producer: Actor;
  let reporter: Actor;
  beforeAll(async () => {
    // العدّادات تُقارن بالصفوف فور الكتابة: بلا لقطة هنا، واللقطة لها اختبارها
    h = await createHarness({ env: { MEDIA_WORKER_TOKEN: workerToken, DASHBOARD_SNAPSHOT_MS: '0' }, overrides: [[OBJECT_STORAGE, storage]] });
    await ensureForm(h);
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    office = await newOffice();
    otherOffice = await newOffice();
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: otherOffice }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
  });
  afterAll(async () => {
    // القواعد عامة على القاعدة المشتركة بين ملفات الاختبار: لا تبقى بعد هذا الملف
    await h.pool.query(`DELETE FROM notification_rules WHERE created_by = $1`, [admin.id]);
    await h.close();
  });

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`),
    post: (url: string, body?: object) =>
      http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body ?? {}),
    put: (url: string, body: object, ifMatch?: string) => {
      const r = http().put(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID());
      return (ifMatch ? r.set('If-Match', ifMatch) : r).send(body);
    },
    del: (url: string, ifMatch?: string) => {
      const r = http().delete(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID());
      return ifMatch ? r.set('If-Match', ifMatch) : r;
    },
  });
  const material = async (opts: { priority?: string; title?: string; shotAt?: string } = {}) => {
    const res = await as(reporter)
      .post('/materials', {
        title: opts.title ?? 'عنوان',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority: opts.priority ?? 'normal',
        ...(opts.shotAt ? { shot_at: opts.shotAt } : {}),
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      })
      .expect(201);
    return res.body.id as string;
  };
  /** أصل متحقق للمادة كما يتركه عامل الوسائط، بالبصمات المعطاة. */
  const original = async (materialId: string, f: { sha?: Buffer; size?: number; head?: Buffer; tail?: Buffer; phash?: string } = {}) => {
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, head_sha256, tail_sha256, storage_key, perceptual_hash)
       VALUES ($1, 'original', 'received', $2, $3, $4, $5, $6, $7::bigint[]) RETURNING id`,
      [materialId, f.size ?? 5000, f.sha ?? randomBytes(32), f.head ?? randomBytes(32), f.tail ?? randomBytes(32), `tus/${randomUUID()}`, f.phash ?? null],
    );
    await h.pool.query(`UPDATE material_files SET state = 'verified', verified_at = now() WHERE id = $1`, [rows[0]!.id]);
    return rows[0]!.id;
  };
  const inbox = async (userId: string, materialId: string) =>
    (await h.pool.query(`SELECT type, rule_id, assignment_state, escalate_at FROM notifications WHERE user_id = $1 AND material_id = $2 ORDER BY created_at`, [userId, materialId])).rows;

  describe('notification rules (admin)', () => {
    const rule = (over: object = {}) => ({
      name: 'وارد المكتب',
      event_type: 'material.created',
      scope_kind: 'office',
      scope_id: office,
      recipient_roles: ['supervisor'],
      channels: ['in_app', 'apns'],
      assignment: true,
      escalation: [{ level: 1, after_seconds: 60, recipient_roles: ['editor_in_chief'], channels: ['in_app'] }],
      ...over,
    });

    it('creates, reads, replaces with If-Match and deletes; editor in chief reads, others are refused', async () => {
      const created = await as(admin).post('/notification-rules', rule()).expect(201);
      expect(created.headers.etag).toBe('"1"');
      expect(created.body).toMatchObject({ row_version: 1, scope_kind: 'office', scope_id: office, quiet_hours: null, enabled: true, created_by: admin.id });
      const id = created.body.id as string;
      expect((await as(chief).get(`/notification-rules/${id}`).expect(200)).body.escalation).toHaveLength(1);
      expect((await as(chief).get('/notification-rules').expect(200)).body.items.some((r: { id: string }) => r.id === id)).toBe(true);
      await as(chief).post('/notification-rules', rule()).expect(403);
      await as(supervisor).get('/notification-rules').expect(403);

      const replaced = await as(admin)
        .put(`/notification-rules/${id}`, rule({ quiet_hours: { start: '22:00', end: '06:00', timezone: 'Asia/Gaza' }, enabled: false }), '"1"')
        .expect(200);
      expect(replaced.body).toMatchObject({ row_version: 2, enabled: false, quiet_hours: { start: '22:00', end: '06:00', timezone: 'Asia/Gaza' } });
      expect((await as(admin).put(`/notification-rules/${id}`, rule(), '"1"').expect(412)).body.code).toBe('precondition_failed');
      await as(admin).del(`/notification-rules/${id}`, '"1"').expect(412);
      await as(admin).del(`/notification-rules/${id}`, '"2"').expect(204);
      await as(admin).get(`/notification-rules/${id}`).expect(404);
      const { rows } = await h.pool.query(`SELECT action, details FROM audit_log WHERE target_id = $1 ORDER BY id`, [id]);
      expect(rows).toEqual([
        { action: 'notification_rule.created', details: { rule_id: id } },
        { action: 'notification_rule.replaced', details: { rule_id: id } },
        { action: 'notification_rule.deleted', details: { rule_id: id } },
      ]);
    });

    it('refuses what the schema cannot say: no recipient, escalation without assignment, gaps, scope mismatch, unknown zone', async () => {
      const fields = async (body: object) => (await as(admin).post('/notification-rules', body).expect(422)).body.details.fields;
      expect(await fields(rule({ recipient_roles: [], recipient_permissions: [] }))).toContain('/recipient_roles');
      expect(await fields(rule({ assignment: false }))).toContain('/escalation');
      expect(
        await fields(rule({ escalation: [{ level: 2, after_seconds: 60, recipient_roles: ['editor_in_chief'], channels: ['in_app'] }] })),
      ).toContain('/escalation/0');
      expect(await fields(rule({ scope_kind: 'all' }))).toContain('/scope_id');
      expect(await fields(rule({ quiet_hours: { start: '22:00', end: '06:00', timezone: 'Mars/Olympus' } }))).toContain('/quiet_hours/timezone');
    });

    it('an enabled rule replaces the default fan-out: its scoped recipients get a task tied to the rule, then its chain escalates', async () => {
      const id = (await as(admin).post('/notification-rules', rule()).expect(201)).body.id as string;
      try {
        const m = await material();
        await drainOutbox(h);
        const [n] = await inbox(supervisor.id, m);
        expect(n).toMatchObject({ type: 'material.created', rule_id: id, assignment_state: 'assigned' });
        expect(n.escalate_at).not.toBeNull();
        expect(await inbox(otherSupervisor.id, m)).toEqual([]);

        await h.pool.query(`UPDATE notifications SET escalate_at = now() - interval '1 second' WHERE material_id = $1 AND user_id = $2`, [m, supervisor.id]);
        await h.app.get(EscalationWorker).escalateDue();
        await drainOutbox(h);
        const escalated = (await inbox(chief.id, m)).filter((r) => r.type === 'notification.escalated');
        expect(escalated).toEqual([expect.objectContaining({ rule_id: id, assignment_state: 'assigned' })]);
        // آخر مستوى في السلسلة: لا موعد بعده
        expect((await inbox(supervisor.id, m))[0].escalate_at).toBeNull();
      } finally {
        await as(admin).del(`/notification-rules/${id}`).expect(204);
      }
    }, 30_000);
  });

  describe('rules and the default fan-out', () => {
    it('a rule that does not match the material leaves its default notifications in place', async () => {
      const id = (
        await as(admin)
          .post('/notification-rules', {
            name: 'مكتب آخر',
            event_type: 'material.created',
            scope_kind: 'office',
            scope_id: otherOffice,
            recipient_roles: ['supervisor'],
            channels: ['in_app'],
          })
          .expect(201)
      ).body.id as string;
      try {
        const m = await material();
        await drainOutbox(h);
        expect(await inbox(supervisor.id, m)).toEqual([expect.objectContaining({ type: 'material.created', rule_id: null, assignment_state: 'assigned' })]);
      } finally {
        await as(admin).del(`/notification-rules/${id}`).expect(204);
      }
    }, 30_000);
  });

  describe('«اطّلعت» on the material', () => {
    it('records who acknowledged and when, visible to the reporter', async () => {
      const m = await material();
      await drainOutbox(h);
      const [n] = (await h.pool.query(`SELECT id FROM notifications WHERE user_id = $1 AND material_id = $2`, [supervisor.id, m])).rows;
      await http().post(`/v1/notifications/${n.id}/ack`).set('Authorization', `Bearer ${supervisor.token}`).set('Idempotency-Key', randomUUID()).expect(204);
      const seen = (await as(reporter).get(`/materials/${m}`).expect(200)).body;
      expect(seen).toMatchObject({ editorial_state: 'acknowledged', acknowledged_by: supervisor.id });
      expect(Date.parse(seen.acknowledged_at)).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  describe('GET /materials sort', () => {
    it('pages every sort with its own cursor, and refuses a cursor from another sort', async () => {
      const ids = [
        await material({ shotAt: '2026-01-01T00:00:00Z' }),
        await material(),
        await material({ shotAt: '2026-03-01T00:00:00Z' }),
      ];
      const walk = async (sort: string) => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const res: request.Response = await as(reporter).get(`/materials?sort=${sort}&limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
          seen.push(...res.body.items.map((i: { id: string }) => i.id));
          cursor = res.body.next_cursor;
        } while (cursor);
        return seen.filter((id) => ids.includes(id));
      };
      expect(await walk('created_desc')).toEqual([...ids].reverse());
      expect(await walk('created_asc')).toEqual(ids);
      // غير المؤرَّخ أولًا كترتيب الفهرس، ثم الأحدث تصويرًا
      expect(await walk('shot_desc')).toEqual([ids[1], ids[2], ids[0]]);
      expect((await walk('updated_desc')).sort()).toEqual([...ids].sort());
      const first = await as(reporter).get('/materials?sort=created_asc&limit=1').expect(200);
      await as(reporter).get(`/materials?sort=created_desc&cursor=${first.body.next_cursor}`).expect(400);
    });
  });

  describe('reporter_legal_name', () => {
    // الإعداد الافتراضي separate (ADR 0021)؛ التبديل بين الوضعين في reporter-identity-setting.spec.ts
    it('only a reporter_identity:read holder gets it, and every read is audited; others do not see the key', async () => {
      const m = await material();
      await h.pool.query(`UPDATE users SET legal_name_enc = $2 WHERE id = $1`, [reporter.id, fieldKeyring(h.config).encrypt(Buffer.from('الاسم الحقيقي'))]);
      const holder = await loginAs(h, [{ role: 'editor_in_chief' }]);
      await h.pool.query(`INSERT INTO user_permissions (user_id, permission, granted_by, reason) VALUES ($1, 'reporter_identity:read', $2, 'test')`, [holder.id, admin.id]);
      const login = await http().post('/v1/auth/login').send({ email: holder.email, password: holder.password }).expect(200);
      const withName = await http().get(`/v1/materials/${m}`).set('Authorization', `Bearer ${login.body.access_token}`).expect(200);
      expect(withName.body.reporter_legal_name).toBe('الاسم الحقيقي');
      const { rows } = await h.pool.query(`SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'material.sensitive_read' AND target_id = $2`, [holder.id, m]);
      expect(rows).toEqual([{ details: { material_id: m, field_keys: ['reporter_legal_name'] } }]);
      expect('reporter_legal_name' in (await as(chief).get(`/materials/${m}`).expect(200)).body).toBe(false);
      expect('reporter_legal_name' in (await as(reporter).get(`/materials/${m}`).expect(200)).body).toBe(false);
    });
  });

  describe('export on request', () => {
    it('none → requested (202, one event) → same request 200 → worker registers it → ready → signed link audited', async () => {
      const m = await material();
      await as(producer).get(`/materials/${m}/export`).expect(404); // خارج نطاق الإنتاج قبل القبول
      expect((await as(chief).get(`/materials/${m}/export`).expect(200)).body).toMatchObject({ state: 'none', source_file_id: null });
      expect((await as(chief).post(`/materials/${m}/export`).expect(409)).body.code).toBe('upload_state_conflict');
      const source = await original(m);
      const first = await as(chief).post(`/materials/${m}/export`).expect(202);
      expect(first.body).toMatchObject({ state: 'requested', source_file_id: source, requested_by: chief.id, file_id: null });
      expect((await as(chief).post(`/materials/${m}/export`).expect(200)).body.state).toBe('requested');
      const events = (await h.pool.query(`SELECT payload FROM outbox_events WHERE type = 'export.requested' AND aggregate_id = $1`, [m])).rows;
      expect(events).toEqual([{ payload: { material_id: m, source_file_id: source, requested_by: chief.id } }]);
      expect((await as(chief).get(`/materials/${m}/export/download-url`).expect(409)).body.code).toBe('export_not_ready');

      const key = `derived/${m}/${source}/export.zip`;
      storage.sizes.set(key, 777);
      await http()
        .post(`/internal/media/files/${source}/derivatives`)
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ kind: 'export', storage_key: key, sha256: hex(randomBytes(32)), size_bytes: 777, mime_type: 'application/zip', technical: { duration_ms: 1000, start_pts_us: 0 } })
        .expect(200);
      const ready = (await as(chief).get(`/materials/${m}/export`).expect(200)).body;
      expect(ready).toMatchObject({ state: 'ready', file_id: expect.any(String) });
      const link = await as(chief).get(`/materials/${m}/export/download-url`).expect(200);
      expect(link.headers['cache-control']).toBe('no-store');
      expect(link.body.url).toContain(key);
      // الحزمة ليست MaterialFile في استجابة المادة
      expect((await as(chief).get(`/materials/${m}`).expect(200)).body.files.map((f: { kind: string }) => f.kind)).toEqual(['original']);
    });
  });

  describe('transcript and captions (R11, threat-model §9.1)', () => {
    it('only those who may edit the material see them in files and get their link; others get the missing-file 404; issuing is a sensitive read', async () => {
      const m = await material();
      const source = await original(m);
      const ids: Record<string, string> = {};
      for (const [kind, mime] of [['transcript', 'application/json'], ['captions', 'text/vtt']] as const) {
        const key = `derived/${m}/${source}/${kind}`;
        storage.sizes.set(key, 40);
        ids[kind] = (
          await http()
            .post(`/internal/media/files/${source}/derivatives`)
            .set('Authorization', `Bearer ${workerToken}`)
            .send({ kind, storage_key: key, sha256: hex(randomBytes(32)), size_bytes: 40, mime_type: mime, technical: { duration_ms: 1000, start_pts_us: 0 } })
            .expect(200)
        ).body.file_id as string;
      }
      // المنتج يرى المادة بعد قبولها للإنتاج
      for (const to of ['acknowledged', 'reviewing', 'accepted']) {
        await as(supervisor).post(`/materials/${m}/transitions`, { track: 'editorial', to, reason: 'r11' }).expect(200);
      }
      const rights = await loginAs(h, [{ role: 'rights_officer' }]);
      const editors = { reporter, supervisor, chief, admin };
      const readers = { producer, rights };
      const kinds = (body: { files: Array<{ kind: string }> }) => body.files.map((f) => f.kind);
      const missing = (await as(chief).get(`/materials/${m}/files/${randomUUID()}/download-url`).expect(404)).body;
      const shape = ({ request_id: _r, ...rest }: Record<string, unknown>) => rest;

      for (const [name, a] of Object.entries(editors)) {
        expect([name, kinds((await as(a).get(`/materials/${m}`).expect(200)).body)]).toEqual([name, expect.arrayContaining(['transcript', 'captions'])]);
        for (const kind of ['transcript', 'captions']) {
          await as(a).get(`/materials/${m}/files/${ids[kind]}/download-url`).expect(200);
          const { rows } = await h.pool.query(
            `SELECT details FROM audit_log WHERE actor_id = $1 AND action = 'material.sensitive_read' AND target_id = $2 AND details->>'file_id' = $3`,
            [a.id, m, ids[kind]],
          );
          expect(rows).toEqual([{ details: { material_id: m, file_id: ids[kind], field_keys: [kind] } }]);
        }
      }
      for (const [name, a] of Object.entries(readers)) {
        const listed = kinds((await as(a).get(`/materials/${m}`).expect(200)).body);
        expect([name, listed.filter((k) => k === 'transcript' || k === 'captions')]).toEqual([name, []]);
        const page = (await as(a).get('/materials?limit=100').expect(200)).body.items.find((x: { id: string }) => x.id === m);
        if (page) expect(kinds(page).some((k) => k === 'transcript' || k === 'captions')).toBe(false);
        for (const kind of ['transcript', 'captions']) {
          const res = await as(a).get(`/materials/${m}/files/${ids[kind]}/download-url`).expect(404);
          expect(shape(res.body)).toEqual(shape(missing));
        }
        const { rows } = await h.pool.query(`SELECT 1 FROM audit_log WHERE actor_id = $1 AND target_id = $2 AND action = 'material.sensitive_read'`, [a.id, m]);
        expect(rows).toEqual([]);
      }
    });
  });

  describe('duplicates', () => {
    it('ranks sha256, cheap hash and perceptual candidates in the caller scope only, with ids and states only', async () => {
      const sha = randomBytes(32);
      const head = randomBytes(32);
      const tail = randomBytes(32);
      const frame = () => randomBytes(8).readBigInt64BE();
      const [a, b, c] = [frame(), frame(), frame()];
      const subject = await material();
      await original(subject, { sha, size: 9000, head, tail, phash: `{${a},${b},${c}}` });
      const same = await material();
      await original(same, { sha });
      const cheap = await material();
      await original(cheap, { size: 9000, head, tail });
      const looksAlike = await material();
      await original(looksAlike, { phash: `{${a ^ 1n},${b},${c ^ 1n}}` }); // متوسط هامنغ (1+0+1)/3
      const unrelated = await material();
      await original(unrelated, { phash: `{${~a},${~b},${~c}}` }); // كل البتات مختلفة

      const res = await as(chief).get(`/materials/${subject}/duplicates`).expect(200);
      const mine = res.body.items.filter((c: { material_id: string }) => [same, cheap, looksAlike, unrelated].includes(c.material_id));
      expect(mine.map((c: { material_id: string; match: string }) => [c.material_id, c.match])).toEqual([
        [same, 'sha256'],
        [cheap, 'cheap_hash'],
        [looksAlike, 'perceptual'],
      ]);
      expect(mine[2].distance).toBeCloseTo(2 / 3);
      expect(Object.keys(mine[0]).sort()).toEqual(['created_at', 'distance', 'editorial_state', 'file_id', 'match', 'material_id', 'priority']);
      // مشرف مكتب آخر لا يرى المادة ولا مرشّحيها
      await as(otherSupervisor).get(`/materials/${subject}/duplicates`).expect(404);
    });
  });

  describe('newsroom dashboard', () => {
    it('counts within the caller scope only, with ids, numbers and states only', async () => {
      const m = await material({ priority: 'urgent' });
      await original(m);
      const mine = (await as(supervisor).get('/dashboard/newsroom').expect(200));
      expect(mine.headers['cache-control']).toBe('no-store');
      expect(mine.body.urgent_open).toBeGreaterThanOrEqual(1);
      expect(mine.body.editorial.find((c: { state: string }) => c.state === 'inbox')?.count).toBeGreaterThanOrEqual(1);
      const others = (await as(otherSupervisor).get('/dashboard/newsroom').expect(200)).body;
      expect(others.editorial).toEqual([]);
      expect(others.urgent_open).toBe(0);
      expect(JSON.stringify(mine.body)).not.toContain('عنوان');
      await as(reporter).get('/dashboard/newsroom').expect(403);
    });

    it('each state count and the open urgent count equal the scoped rows exactly', async () => {
      await material({ priority: 'urgent' });
      const done = await material();
      for (const to of ['acknowledged', 'reviewing', 'accepted']) {
        await as(supervisor).post(`/materials/${done}/transitions`, { track: 'editorial', to, reason: 'dashboard' }).expect(200);
      }
      const body = (await as(supervisor).get('/dashboard/newsroom').expect(200)).body;
      const tally = async (column: string) =>
        (
          await h.pool.query<{ state: string; count: number }>(
            `SELECT ${column} AS state, count(*)::int AS count FROM materials WHERE office_id = $1 GROUP BY 1 ORDER BY 1`,
            [office],
          )
        ).rows;
      expect(body.editorial).toEqual(await tally('editorial_state'));
      expect(body.technical).toEqual(await tally('technical_state'));
      expect(body.rights).toEqual(await tally('rights_state'));
      const { rows } = await h.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM materials WHERE office_id = $1 AND priority = 'urgent' AND editorial_state NOT IN ('published', 'rejected')`,
        [office],
      );
      expect(body.urgent_open).toBe(rows[0]!.n);
    });

    it('a snapshot is reused for the same user and scope for at most DASHBOARD_SNAPSHOT_MS, never across users', async () => {
      const snap = await createHarness({ env: { DASHBOARD_SNAPSHOT_MS: '1500' } });
      try {
        const get = (a: Actor) => request(snap.app.getHttpServer()).get('/v1/dashboard/newsroom').set('Authorization', `Bearer ${a.token}`).expect(200);
        const one = (await get(supervisor)).body;
        await material({ priority: 'urgent' });
        const again = (await get(supervisor)).body;
        expect(again.generated_at).toBe(one.generated_at);
        expect(again.urgent_open).toBe(one.urgent_open);
        // مشرف المكتب الآخر لقطته له: لا يرى عدّادات غيره
        const others = (await get(otherSupervisor)).body;
        expect(others.urgent_open).toBe(0);
        await new Promise((r) => setTimeout(r, 1600));
        const fresh = (await get(supervisor)).body;
        expect(fresh.generated_at).not.toBe(one.generated_at);
        expect(fresh.urgent_open).toBe(one.urgent_open + 1);
      } finally {
        await snap.close();
      }
    });
  });
});
