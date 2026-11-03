import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { DashboardService } from '../../src/dashboard/dashboard.service';
import { TusdHooksService } from '../../src/uploads/tusd-hooks.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { VerificationWorker } from '../../src/verification/verification.worker';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

/** تخزين في الذاكرة يكفي التحقق ورابط التنزيل الموقّع (بلا شبكة). */
class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Buffer>();
  async head(_bucket: string, key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async read(_bucket: string, key: string) {
    return Readable.from([this.objects.get(key)!]);
  }
  presignGet(bucket: string, key: string, expiresSeconds: number) {
    return `https://media.example.test/${bucket}/${key}?X-Amz-Expires=${expiresSeconds}`;
  }
}

// رفع النسخة المُنتَجة، والتسليم بها، وحصر ملفات المادة بالدور، والمصغّرة (ADR 0104)
describe('produced file upload, delivery on done, file visibility by role, thumbnail', () => {
  const storage = new MemoryStorage();
  let h: Harness;
  let office: string;
  let reporter: Actor;
  let supervisor: Actor;
  let otherSupervisor: Actor;
  let producer: Actor;
  let producer2: Actor;
  let chief: Actor;
  let rights: Actor;
  let admin: Actor;

  beforeAll(async () => {
    h = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
    await ensureForm(h);
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    office = await newOffice();
    const otherOffice = await newOffice();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: otherOffice }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    producer2 = await loginAs(h, [{ role: 'producer' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    // جلسات مكتملة تركتها ملفات أخرى لا تدخل طابور هذا الاختبار
    await h.pool.query(`UPDATE upload_sessions SET state = 'failed', failure_reason = 'aborted' WHERE state = 'completed'`);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`),
    post: (url: string, body: object, key: string = randomUUID()) =>
      http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body),
  });

  const material = async () => {
    const res = await as(reporter)
      .post('/materials', {
        title: 'عنوان تجريبي',
        material_types: ['report'],
        governorate: 'محافظة',
        city: 'مدينة',
        priority: 'urgent',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      })
      .expect(201);
    await h.pool.query(`UPDATE materials SET editorial_state = 'accepted' WHERE id = $1`, [res.body.id]);
    return res.body.id as string;
  };
  const assigned = async (m: string, to: Actor = producer) => {
    const res = await as(supervisor)
      .post(`/materials/${m}/assignments`, { assignee_id: to.id, due_at: new Date(Date.now() + 3600_000).toISOString() })
      .expect(201);
    return res.body.id as string;
  };
  const sessionBody = (m: string, content: Buffer) => ({
    material_id: m,
    kind: 'produced',
    size_bytes: content.length,
    filename: 'cut-v1.mp4',
    mime_type: 'video/mp4',
    client_sha256: createHash('sha256').update(content).digest('hex'),
  });
  const file = async (m: string, kind: string, state: string, extra: { derivedFrom?: string; licenseId?: string; verifiedAt?: string } = {}) =>
    (
      await h.pool.query<{ id: string }>(
        `INSERT INTO material_files (material_id, kind, state, derived_from_id, license_id, storage_key, size_bytes, sha256, mime_type, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, 10, $7, 'image/jpeg', CASE WHEN $3 = 'verified' THEN COALESCE($8::timestamptz, now()) END) RETURNING id`,
        [m, kind, state, extra.derivedFrom ?? null, extra.licenseId ?? null, `derived/${m}/${randomUUID()}`, state === 'verified' ? randomBytes(32) : null, extra.verifiedAt ?? null],
      )
    ).rows[0]!.id;

  /** يرفع المونتير نسخته بالمسار كله: الجلسة، ثم اكتمال tusd، ثم التحقق على الخادم. */
  const uploadProduced = async (m: string, by: Actor = producer) => {
    const content = randomBytes(4096);
    const created = await as(by).post('/uploads', sessionBody(m, content)).expect(201);
    const id = created.body.id as string;
    await h.pool.query(`UPDATE upload_sessions SET state = 'in_progress', storage_key = $2 WHERE id = $1`, [id, `tus/${id}`]);
    storage.objects.set(`tus/${id}`, content);
    await h.app.get(TusdHooksService).handle({
      Type: 'post-finish',
      Event: { Upload: { ID: id, Size: content.length, MetaData: { upload_session_id: id }, Storage: { Key: `tus/${id}`, Bucket: 'uploads' } }, HTTPRequest: {} },
    } as never);
    const worker = h.app.get(VerificationWorker);
    while (await worker.verifyNext());
    const { rows } = await h.pool.query<{ file_id: string; state: string }>(`SELECT file_id, state FROM upload_sessions WHERE id = $1`, [id]);
    expect(rows[0]!.state).toBe('verified');
    return { sessionId: id, fileId: rows[0]!.file_id };
  };

  it('uploads the produced file for the assignee only, leaving the original, its receipt and the three states untouched', async () => {
    const m = await material();
    const original = await file(m, 'original', 'verified');
    const before = (await h.pool.query(`SELECT technical_state, editorial_state, rights_state, version FROM materials WHERE id = $1`, [m])).rows[0];

    // بلا مهمة له: المراسل منشئ المادة والمونتير الآخر 403، ومن لا يرى المادة 404
    const content = randomBytes(64);
    expect((await as(producer).post('/uploads', sessionBody(m, content)).expect(403)).body.code).toBe('forbidden_scope');
    const task = await assigned(m);
    expect((await as(producer2).post('/uploads', sessionBody(m, content)).expect(403)).body.code).toBe('forbidden_scope');
    expect((await as(reporter).post('/uploads', sessionBody(m, content)).expect(403)).body.code).toBe('forbidden_scope');
    await as(otherSupervisor).post('/uploads', sessionBody(m, content)).expect(404);
    // المونتير لا يرفع أصلًا ولا نسخة خفيفة لمادة غيره
    await as(producer).post('/uploads', { ...sessionBody(m, content), kind: 'original' }).expect(404);
    await as(producer).post('/uploads', { ...sessionBody(m, content), kind: 'proxy' }).expect(422);

    const { sessionId, fileId } = await uploadProduced(m);
    const f = (await h.pool.query(`SELECT kind, state, derived_from_id, receipt_number FROM material_files WHERE id = $1`, [fileId])).rows[0];
    expect(f).toEqual({ kind: 'produced', state: 'verified', derived_from_id: null, receipt_number: null });
    expect((await h.pool.query(`SELECT technical_state, editorial_state, rights_state, version FROM materials WHERE id = $1`, [m])).rows[0]).toEqual(before);
    expect((await h.pool.query(`SELECT state FROM material_files WHERE id = $1`, [original])).rows[0].state).toBe('verified');

    // الأحداث بنوعها، ولا إشعار ولا ظهور في «الوارد الآن»
    const events = (await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [sessionId])).rows;
    expect(events.map((e) => e.type)).toEqual(['upload.started', 'upload.original_received', 'upload.verified']);
    expect(events.every((e) => e.payload.kind === 'produced')).toBe(true);
    await drainOutbox(h);
    const notes = await h.pool.query(`SELECT type FROM notifications WHERE material_id = $1 AND type LIKE 'upload.%'`, [m]);
    expect(notes.rows).toEqual([]);
    const pending = await as(producer).post('/uploads', sessionBody(m, randomBytes(32))).expect(201);
    const board = await h.app.get(DashboardService).newsroom({ userId: chief.id, officeId: null, organizationId: null, roles: [{ role: 'editor_in_chief', scopeKind: 'all', scopeId: '' }], permissions: new Set() });
    expect((board.uploads_in_progress ?? []).map((u) => u.upload_session_id)).not.toContain(pending.body.id);

    // التسليم بالملف: المهمة done وفيها الملف، والتدقيق بمعرّفه
    await as(producer).post(`/assignments/${task}/transitions`, { to: 'in_progress' }).expect(200);
    await as(producer).post(`/assignments/${task}/transitions`, { to: 'in_progress', produced_file_id: fileId }).expect(422);
    const done = await as(producer).post(`/assignments/${task}/transitions`, { to: 'done', produced_file_id: fileId }).expect(200);
    expect(done.body).toMatchObject({ state: 'done', produced_file_id: fileId });
    const v = schemaValidator('MaterialAssignment');
    expect(v(done.body) ? [] : v.errors).toEqual([]);
    expect((await as(supervisor).get(`/assignments/${task}`).expect(200)).body.produced_file_id).toBe(fileId);
    const audit = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'assignment.transitioned' AND target_id = $1 ORDER BY id DESC LIMIT 1`, [task]);
    expect(audit.rows[0].details).toMatchObject({ assignment_id: task, to: 'done', file_id: fileId });
  });

  it('refuses a produced file that is not the assignee upload of the same material (422)', async () => {
    const m = await material();
    const other = await material();
    const task = await assigned(m);
    const otherTask = await assigned(other, producer2);
    const foreign = (await uploadProduced(other, producer2)).fileId;
    const original = await file(m, 'original', 'verified');
    const workerProduced = await file(m, 'produced', 'verified', { derivedFrom: original });
    await as(producer).post(`/assignments/${task}/transitions`, { to: 'in_progress' }).expect(200);
    for (const id of [foreign, original, workerProduced, randomUUID(), 'not-a-uuid']) {
      const res = await as(producer).post(`/assignments/${task}/transitions`, { to: 'done', produced_file_id: id });
      expect([res.status, res.body.code]).toEqual([422, 'validation_failed']);
    }
    // التسليم بلا ملف قائم كما كان
    expect((await as(producer).post(`/assignments/${task}/transitions`, { to: 'done' }).expect(200)).body.produced_file_id).toBeNull();
    await as(producer2).post(`/assignments/${otherTask}/transitions`, { to: 'returned', produced_file_id: foreign }).expect(422);
  });

  it('shows produced files to production roles only and delivery files to no one; downloads follow the same rule', async () => {
    const m = await material();
    await assigned(m);
    const { fileId: produced } = await uploadProduced(m);
    const original = await file(m, 'original', 'verified');
    const workerProduced = await file(m, 'produced', 'verified', { derivedFrom: original });
    const delivery = await file(m, 'delivery', 'verified', { derivedFrom: original, licenseId: randomUUID() });
    const kindsFor = async (a: Actor) => {
      const one = (await as(a).get(`/materials/${m}`).expect(200)).body.files.map((f: { id: string }) => f.id);
      const listed = (await as(a).get(`/materials?limit=100`).expect(200)).body.items.find((x: { id: string }) => x.id === m)?.files.map((f: { id: string }) => f.id);
      expect(listed).toEqual(one);
      return one as string[];
    };
    for (const a of [supervisor, chief, producer, admin]) {
      const ids = await kindsFor(a);
      expect(ids).toEqual(expect.arrayContaining([produced, workerProduced, original]));
      expect(ids).not.toContain(delivery);
      await as(a).get(`/materials/${m}/files/${produced}/download-url`).expect(200);
    }
    for (const a of [reporter, rights]) {
      const ids = await kindsFor(a);
      expect(ids).toContain(original);
      expect(ids).not.toEqual(expect.arrayContaining([produced]));
      expect(ids).not.toContain(workerProduced);
      expect(ids).not.toContain(delivery);
      await as(a).get(`/materials/${m}/files/${produced}/download-url`).expect(404);
      await as(a).get(`/materials/${m}/files/${workerProduced}/download-url`).expect(404);
    }
    // المرفوعة من حاوية الرفع، ومشتق العامل من حاوية الوسائط، والإصدار مدقَّق
    const up = await as(supervisor).get(`/materials/${m}/files/${produced}/download-url`).expect(200);
    expect(new URL(up.body.url).pathname.startsWith(`/${h.config.S3_BUCKET_UPLOADS}/`)).toBe(true);
    const derived = await as(chief).get(`/materials/${m}/files/${workerProduced}/download-url`).expect(200);
    expect(new URL(derived.body.url).pathname.startsWith(`/${h.config.S3_BUCKET_MEDIA}/`)).toBe(true);
    await as(chief).get(`/materials/${m}/files/${delivery}/download-url`).expect(404);
    const issued = await h.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'material_file.download_url_issued' AND target_id = $1`, [produced]);
    expect(issued.rows[0].n).toBe(5);
    const valid = schemaValidator('Material');
    const body = (await as(chief).get(`/materials/${m}`).expect(200)).body;
    expect(valid(body) ? [] : valid.errors).toEqual([]);
  });

  it('carries the latest verified thumbnail id on the list item and the read, and null without one', async () => {
    const m = await material();
    expect((await as(supervisor).get(`/materials/${m}`).expect(200)).body.thumbnail_file_id).toBeNull();
    const original = await file(m, 'original', 'verified');
    await file(m, 'thumbnail', 'received', { derivedFrom: original });
    expect((await as(supervisor).get(`/materials/${m}`).expect(200)).body.thumbnail_file_id).toBeNull();
    const older = await file(m, 'thumbnail', 'verified', { verifiedAt: '2026-11-01T10:00:00Z' });
    const latest = await file(m, 'thumbnail', 'verified', { verifiedAt: '2026-11-02T10:00:00Z' });
    expect(older).not.toBe(latest);
    for (const a of [reporter, supervisor, chief]) {
      expect((await as(a).get(`/materials/${m}`).expect(200)).body.thumbnail_file_id).toBe(latest);
      const item = (await as(a).get(`/materials?limit=100`).expect(200)).body.items.find((x: { id: string }) => x.id === m);
      expect(item.thumbnail_file_id).toBe(latest);
    }
  });
});
