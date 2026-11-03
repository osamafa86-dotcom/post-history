import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import request from 'supertest';
import { DB, type Database } from '../../src/database/database.module';
import { uploadSessions } from '../../src/database/schema/schema';
import { MEDIA_STREAM, RENDER_STREAM } from '../../src/outbox/media-stream';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { recordVerification } from '../../src/verification/verification';
import { createHarness, drainOutbox, ensureForm, type Harness, loginAs, seedUploadSession } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

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

// نص محايد؛ والعنوان كناري: لا يظهر في حدث ولا إشعار (ADR 0091)
const CANARY = 'سطر كناري للاختبار';
const CITY = 'مدينة تجريبية';
const GOVERNORATE = 'محافظة تجريبية';
const cp = (n: number) => String.fromCodePoint(n);

// نسخ قالب «مواد متداولة» (ADR 0091): الطلب والشروط والحدّ، ونقاط العامل، والرابط، والإشعار
describe('circulated-template renders', () => {
  const storage = new FakeStorage();
  const workerToken = randomBytes(32).toString('base64url');
  let h: Harness;
  let office: string;
  let otherOffice: string;
  let reporter: Actor;
  let supervisor: Actor;
  let otherSupervisor: Actor;
  let producer: Actor;
  let chief: Actor;
  let rights: Actor;
  let admin: Actor;

  beforeAll(async () => {
    h = await createHarness({ env: { MEDIA_WORKER_TOKEN: workerToken, MEDIA_ENABLE_RENDERS: 'true' }, overrides: [[OBJECT_STORAGE, storage]] });
    await ensureForm(h);
    const newOffice = async () => (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    office = await newOffice();
    otherOffice = await newOffice();
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    otherSupervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: otherOffice }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const as = (a: Actor) => ({
    get: (url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`),
    post: (url: string, body: object, key = randomUUID()) => http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body),
  });
  const worker = {
    get: (url: string, token = workerToken) => http().get(`/internal/media${url}`).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) => http().post(`/internal/media${url}`).set('Authorization', `Bearer ${workerToken}`).send(body ?? {}),
  };

  const material = async (over: { city?: string; governorate?: string } = {}) => {
    const res = await as(reporter)
      .post('/materials', {
        title: 'عنوان',
        material_types: ['report'],
        governorate: over.governorate ?? GOVERNORATE,
        city: over.city ?? CITY,
        priority: 'normal',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      })
      .expect(201);
    return res.body.id as string;
  };
  /** أصل متحقق كما يتركه عامل الوسائط: مسار صورة ومدته. */
  const original = async (materialId: string, f: { durationMs?: number; video?: boolean } = {}) => {
    const technical = f.video === false ? { container: 'mp4', audio_codec: 'aac' } : { container: 'mp4', video_codec: 'h264' };
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, duration_ms, start_pts_us, technical)
       VALUES ($1, 'original', 'received', 5000, $2, $3, $4, 0, $5) RETURNING id`,
      [materialId, randomBytes(32), `tus/${randomUUID()}`, f.durationMs ?? 60_000, technical],
    );
    await h.pool.query(`UPDATE material_files SET state = 'verified', verified_at = now() WHERE id = $1`, [rows[0]!.id]);
    return rows[0]!.id;
  };
  const setStates = (id: string, editorial: string, rightsState = 'unknown') =>
    h.pool.query(`UPDATE materials SET editorial_state = $2, rights_state = $3 WHERE id = $1`, [id, editorial, rightsState]);
  /** مادة مقبولة بأصل متحقق، جاهزة للطلب. */
  const ready = async (over: Parameters<typeof material>[0] = {}) => {
    const id = await material(over);
    const source = await original(id);
    await setStates(id, 'accepted');
    return { id, source };
  };
  const body = (over: object = {}) => ({ template: 'circulated', aspect: 'vertical', title_lines: [CANARY], show_location: true, label: 'circulated_footage', ...over });
  const events = async (renderId: string) =>
    (await h.pool.query<{ type: string; payload: Record<string, unknown> }>(`SELECT type, payload FROM outbox_events WHERE payload->>'render_id' = $1 ORDER BY id`, [renderId]))
      .rows;
  const register = (source: string, materialId: string, renderId: string, name = 'circulated-vertical.mp4', sha = 'a'.repeat(64)) => {
    const key = `derived/${materialId}/${source}/renders/${renderId}/${name}`;
    storage.sizes.set(key, 4096);
    return worker.post(`/files/${source}/derivatives`, {
      kind: 'circulated_render',
      render_id: renderId,
      storage_key: key,
      sha256: sha,
      size_bytes: 4096,
      mime_type: 'video/mp4',
      technical: { duration_ms: 60_000, start_pts_us: 0, width: 1080, height: 1920, video_codec: 'h264' },
    });
  };

  it('records the request with the server-built location, ids-only event, and leaves the material untouched', async () => {
    const m = await ready();
    const before = (await as(supervisor).get(`/materials/${m.id}`).expect(200)).body;
    const res = await as(supervisor).post(`/materials/${m.id}/renders`, body()).expect(202);
    expect(res.body).toMatchObject({
      material_id: m.id,
      material_version: before.version,
      source_file_id: m.source,
      template: 'circulated',
      aspect: 'vertical',
      title_lines: [CANARY],
      show_location: true,
      location_text: `${CITY}، ${GOVERNORATE}`,
      label: 'circulated_footage',
      state: 'requested',
      file_id: null,
      failure_reason: null,
      requested_by: supervisor.id,
      started_at: null,
      completed_at: null,
    });
    const evs = await events(res.body.id);
    expect(evs).toEqual([
      { type: 'render.requested', payload: { material_id: m.id, render_id: res.body.id, source_file_id: m.source, requested_by: supervisor.id } },
    ]);
    const after = (await as(supervisor).get(`/materials/${m.id}`).expect(200)).body;
    expect([after.version, after.editorial_state, after.rights_state, after.technical_state]).toEqual([
      before.version,
      before.editorial_state,
      before.rights_state,
      before.technical_state,
    ]);
    // بلا مكان: لا نص ولا كبسولة؛ والمدينة وحدها إن ساوت المحافظة
    const off = await as(chief).post(`/materials/${m.id}/renders`, body({ show_location: false, label: 'none', aspect: 'square' })).expect(202);
    expect(off.body).toMatchObject({ show_location: false, location_text: null, label: 'none', aspect: 'square' });
    const same = await ready({ city: CITY, governorate: CITY });
    expect((await as(producer).post(`/materials/${same.id}/renders`, body()).expect(202)).body.location_text).toBe(CITY);
    const list = (await as(producer).get(`/materials/${m.id}/renders`).expect(200)).body.items;
    expect(list.map((r: { id: string }) => r.id)).toEqual([off.body.id, res.body.id]);
    expect((await as(producer).get(`/materials/${m.id}/renders?limit=1`).expect(200)).body.items).toHaveLength(1);
  });

  it('applies the request roles within their scope', async () => {
    const m = await material();
    await original(m);
    await as(reporter).post(`/materials/${m}/renders`, body()).expect(403);
    await as(rights).post(`/materials/${m}/renders`, body()).expect(403);
    await as(admin).get(`/materials/${m}/renders`).expect(403);
    await as(otherSupervisor).post(`/materials/${m}/renders`, body()).expect(404);
    await as(otherSupervisor).get(`/materials/${m}/renders`).expect(404);
    // الإنتاج لا يرى المادة قبل القبول
    await as(producer).post(`/materials/${m}/renders`, body()).expect(404);
    await setStates(m, 'accepted');
    await as(producer).post(`/materials/${m}/renders`, body()).expect(202);
  });

  it('refuses with the failed conditions: source, editorial state and rights', async () => {
    const m = await material();
    await setStates(m, 'inbox', 'blocked');
    const all = await as(supervisor).post(`/materials/${m}/renders`, body()).expect(409);
    expect(all.body).toMatchObject({ code: 'render_not_allowed', details: { failed: ['source', 'editorial_state', 'rights_state'] } });
    expect(all.body.details.max_source_duration_ms).toBeUndefined();
    await original(m, { durationMs: 300_001 });
    await setStates(m, 'published', 'withdrawn');
    const long = await as(supervisor).post(`/materials/${m}/renders`, body()).expect(409);
    expect(long.body.details).toEqual({ failed: ['source', 'rights_state'], max_source_duration_ms: 300_000 });
    const audio = await material();
    await original(audio, { video: false });
    await setStates(audio, 'final_review', 'documented');
    expect((await as(supervisor).post(`/materials/${audio}/renders`, body()).expect(409)).body.details).toEqual({ failed: ['source'] });
    // الحقوق غير الموثقة لا تمنع (قرار المنسّق 2026-11-02)، والحساسية لا تمنع
    const ok = await ready();
    await h.pool.query(`UPDATE materials SET sensitivity_injured = true, rights_state = 'unknown' WHERE id = $1`, [ok.id]);
    await as(supervisor).post(`/materials/${ok.id}/renders`, body()).expect(202);
  });

  // المعاينة الخفيفة (UPLOAD_VERIFIER=in_process، ملحق ADR 0092): الخادم يتحقق ببصمة الأصل وحدها، فلا مدة ولا مسار صورة
  // مسجّلان، وشرط source يرفض. تقرير العامل في مسار الاستئناف (البصمة نفسها) يملأ الفارغ، ولا يستبدل قيمة مسجلة.
  it('an original the API verified itself becomes renderable once the media worker reports its probe; state, checksum and receipt unchanged', async () => {
    const sha = randomBytes(32);
    const s = await seedUploadSession(h, reporter.id, { state: 'completed', size: 5000 });
    await h.pool.query(`UPDATE upload_sessions SET storage_key = $2 WHERE id = $1`, [s.id, `tus/${s.id}`]);
    const db = h.app.get<Database>(DB);
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, s.id));
      // كما يطبّقه المتحقق داخل الخادم: البصمة والحجم وحدهما
      expect(await recordVerification(tx, session!, { result: 'verified', sha256: sha, sizeBytes: 5000 })).toBe('applied');
    });
    const file = async () =>
      (
        await h.pool.query(
          `SELECT id, state, sha256, receipt_number, verified_at, duration_ms, start_pts_us, width, height, technical
           FROM material_files WHERE material_id = $1 AND kind = 'original'`,
          [s.materialId],
        )
      ).rows;
    const [before] = await file();
    expect(before).toMatchObject({ state: 'verified', duration_ms: null, width: null, technical: null });
    await setStates(s.materialId, 'accepted');
    const refused = await as(chief).post(`/materials/${s.materialId}/renders`, body({ show_location: false })).expect(409);
    expect(refused.body.details).toEqual({ failed: ['source'] });

    const probe = { duration_ms: 6000, start_pts_us: 0, width: 1280, height: 720, container: 'mov', video_codec: 'h264', audio_codec: 'aac' };
    const report = (technical: object, checksum = sha) => ({
      result: 'verified',
      sha256: checksum.toString('hex'),
      size_bytes: 5000,
      head_sha256: randomBytes(32).toString('hex'),
      tail_sha256: randomBytes(32).toString('hex'),
      technical,
    });
    const res = await worker.post(`/sessions/${s.id}/verification`, report(probe)).expect(200);
    expect(res.body).toEqual({ state: 'verified', file_id: before.id, receipt_number: before.receipt_number, failure_reason: null });
    const [after] = await file();
    expect(after).toMatchObject({
      id: before.id,
      state: 'verified',
      receipt_number: before.receipt_number,
      verified_at: before.verified_at,
      duration_ms: '6000',
      start_pts_us: '0',
      width: 1280,
      height: 720,
      technical: { container: 'mov', video_codec: 'h264', audio_codec: 'aac' },
    });
    expect(after.sha256.equals(sha)).toBe(true);
    // تقرير لاحق بقيم أخرى لا يستبدل شيئًا، وبصمة أخرى تعارض كما كانت ولا تسجّل شيئًا
    await worker.post(`/sessions/${s.id}/verification`, report({ ...probe, duration_ms: 9000, width: 640, video_codec: 'hevc' })).expect(200);
    expect((await worker.post(`/sessions/${s.id}/verification`, report(probe, randomBytes(32))).expect(409)).body.code).toBe('upload_state_conflict');
    expect(await file()).toEqual([after]);
    expect((await h.pool.query(`SELECT state FROM upload_sessions WHERE id = $1`, [s.id])).rows[0].state).toBe('verified');

    const r = await as(chief).post(`/materials/${s.materialId}/renders`, body({ show_location: false })).expect(202);
    expect(r.body).toMatchObject({ source_file_id: before.id, state: 'requested' });
  });

  it('validates the title by code points and refuses any client location', async () => {
    const m = await ready();
    const post = (over: object) => as(supervisor).post(`/materials/${m.id}/renders`, body(over));
    expect((await post({ title_lines: ['م'.repeat(23)] }).expect(422)).body.code).toBe('validation_failed');
    await post({ title_lines: [`عن${cp(0x202e)}وان`] }).expect(422);
    await post({ title_lines: [' عنوان'] }).expect(422);
    await post({ title_lines: ['أ', 'ب', 'ج', 'د'] }).expect(422);
    await post({ location: 'مكان من العميل' }).expect(422);
    await post({ aspect: 'portrait' }).expect(422);
    // 22 نقطة ترميز خارج المستوى الأساسي = 44 وحدة UTF-16: تُقبل
    const wide = cp(0x1d400).repeat(22);
    expect((await post({ title_lines: [wide, 'م'.repeat(22)] }).expect(202)).body.title_lines).toEqual([wide, 'م'.repeat(22)]);
  });

  it('refuses a location that cannot be drawn with render_location_unusable', async () => {
    const long = await ready({ city: 'م'.repeat(30), governorate: 'ح'.repeat(13) });
    expect((await as(supervisor).post(`/materials/${long.id}/renders`, body()).expect(422)).body.code).toBe('render_location_unusable');
    await as(supervisor).post(`/materials/${long.id}/renders`, body({ show_location: false })).expect(202);
    const bidi = await ready({ city: `مدينة${cp(0x200f)}` });
    expect((await as(supervisor).post(`/materials/${bidi.id}/renders`, body()).expect(422)).body.code).toBe('render_location_unusable');
  });

  it('replays the same key without a second event and caps unfinished renders at three, even under concurrency', async () => {
    const m = await ready();
    const key = randomUUID();
    const first = await as(supervisor).post(`/materials/${m.id}/renders`, body(), key).expect(202);
    const again = await as(supervisor).post(`/materials/${m.id}/renders`, body(), key).expect(202);
    expect(again.body.id).toBe(first.body.id);
    expect(await events(first.body.id)).toHaveLength(1);
    expect((await as(supervisor).post(`/materials/${m.id}/renders`, body({ aspect: 'square' }), key).expect(422)).body.code).toBe('idempotency_key_reused');

    const c = await ready();
    const results = await Promise.all(Array.from({ length: 6 }, () => as(supervisor).post(`/materials/${c.id}/renders`, body())));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(Array(3).fill('render_limit_reached'));
    // نسخة منتهية تفسح مكانًا
    const done = results.find((r) => r.status === 202)!.body.id as string;
    await worker.post(`/renders/${done}/failure`, { reason: 'render_failed' }).expect(204);
    await as(supervisor).post(`/materials/${c.id}/renders`, body()).expect(202);
  });

  it('runs the worker side: read, start, register the derivative, fail; idempotent and ids-only', async () => {
    const m = await ready();
    const r = (await as(supervisor).post(`/materials/${m.id}/renders`, body()).expect(202)).body;
    await worker.get(`/renders/${r.id}`, 'x'.repeat(43)).expect(404);
    expect((await worker.get(`/renders/${randomUUID()}`).expect(410)).body.code).toBe('media_resource_gone');
    expect((await worker.get(`/renders/${r.id}`).expect(200)).body).toEqual({
      render_id: r.id,
      material_id: m.id,
      source_file_id: m.source,
      state: 'requested',
      template: 'circulated',
      aspect: 'vertical',
      title_lines: [CANARY],
      location_text: `${CITY}، ${GOVERNORATE}`,
      label: 'circulated_footage',
    });
    // التسجيل قبل الالتقاط تعارض
    expect((await register(m.source, m.id, r.id).expect(409)).body.code).toBe('upload_state_conflict');
    await worker.post(`/renders/${r.id}/start`).expect(204);
    await worker.post(`/renders/${r.id}/start`).expect(204);
    const started = (await as(supervisor).get(`/materials/${m.id}/renders`).expect(200)).body.items[0];
    expect(started.state).toBe('rendering');
    expect(started.started_at).not.toBeNull();

    // render_id إلزامي للنوع وممنوع لغيره، والأصل في المسار أصل النسخة
    const other = await ready();
    expect((await register(other.source, other.id, r.id).expect(422)).body.details.fields).toEqual(['/render_id']);
    await worker
      .post(`/files/${m.source}/derivatives`, { kind: 'circulated_render', storage_key: `derived/${m.id}/${m.source}/x.mp4`, sha256: 'a'.repeat(64), size_bytes: 1, mime_type: 'video/mp4', technical: { duration_ms: 1, start_pts_us: 0 } })
      .expect(422);
    expect((await register(m.source, m.id, randomUUID()).expect(410)).body.code).toBe('media_resource_gone');

    const file = (await register(m.source, m.id, r.id).expect(200)).body.file_id as string;
    expect((await register(m.source, m.id, r.id).expect(200)).body.file_id).toBe(file);
    expect((await register(m.source, m.id, r.id, 'other.mp4', 'b'.repeat(64)).expect(409)).body.code).toBe('upload_state_conflict');
    const done = (await as(supervisor).get(`/materials/${m.id}/renders`).expect(200)).body.items[0];
    expect(done).toMatchObject({ state: 'ready', file_id: file, failure_reason: null });
    expect(done.completed_at).not.toBeNull();
    await worker.post(`/renders/${r.id}/start`).expect(409);
    await worker.post(`/renders/${r.id}/failure`, { reason: 'render_failed' }).expect(409);
    // ملف القالب لا يظهر في Material.files
    const files = (await as(supervisor).get(`/materials/${m.id}`).expect(200)).body.files as Array<{ id: string }>;
    expect(files.map((f) => f.id)).not.toContain(file);

    // نسخة ثانية من الأصل نفسه: ملف ثانٍ (الفهرس لا يجمعهما)
    const r2 = (await as(supervisor).post(`/materials/${m.id}/renders`, body({ aspect: 'square', show_location: false, label: 'none' })).expect(202)).body;
    await worker.post(`/renders/${r2.id}/start`).expect(204);
    const file2 = (await register(m.source, m.id, r2.id, 'circulated-square.mp4', 'c'.repeat(64)).expect(200)).body.file_id;
    expect(file2).not.toBe(file);

    // الفشل من requested، متساوي الأثر بسببه الأول، وسبب خارج القائمة 422
    const r3 = (await as(supervisor).post(`/materials/${m.id}/renders`, body()).expect(202)).body;
    await worker.post(`/renders/${r3.id}/failure`, { reason: 'because' }).expect(422);
    await worker.post(`/renders/${r3.id}/failure`, { reason: 'source_unavailable' }).expect(204);
    await worker.post(`/renders/${r3.id}/failure`, { reason: 'render_failed' }).expect(204);
    expect((await worker.get(`/renders/${r3.id}`).expect(200)).body.state).toBe('failed');
    const failed = (await as(supervisor).get(`/materials/${m.id}/renders`).expect(200)).body.items[0];
    expect(failed).toMatchObject({ id: r3.id, state: 'failed', failure_reason: 'source_unavailable', started_at: null });
    await worker.post(`/renders/${r3.id}/start`).expect(409);

    expect(await events(r.id)).toEqual([
      { type: 'render.requested', payload: { material_id: m.id, render_id: r.id, source_file_id: m.source, requested_by: supervisor.id } },
      { type: 'render.started', payload: { material_id: m.id, render_id: r.id } },
      { type: 'render.completed', payload: { material_id: m.id, render_id: r.id, file_id: file } },
    ]);
    expect((await events(r3.id)).map((e) => e.type)).toEqual(['render.requested', 'render.failed']);
    expect((await events(r3.id))[1]!.payload).toEqual({ material_id: m.id, render_id: r3.id, failure_reason: 'source_unavailable' });

    // الطالب وحده يُشعَر بالجاهزة والفاشلة، بلا عنوان النسخة ولا مكانها
    await drainOutbox(h);
    const inbox = (
      await h.pool.query<{ user_id: string; type: string; title: string }>(
        `SELECT user_id, type, title FROM notifications WHERE material_id = $1 AND type LIKE 'render.%' ORDER BY created_at`,
        [m.id],
      )
    ).rows;
    expect(inbox.map((n) => [n.user_id, n.type])).toEqual([
      [supervisor.id, 'render.completed'],
      [supervisor.id, 'render.completed'],
      [supervisor.id, 'render.failed'],
    ]);
    // render.requested إلى طابور media:renders وحده (حاوية media-render)، لا إلى media:events
    const redis = new Redis(h.config.REDIS_URL!);
    try {
      const { rows } = await h.pool.query<{ id: string }>(`SELECT id::text FROM outbox_events WHERE type = 'render.requested' AND payload->>'render_id' = $1`, [r.id]);
      const mine = async (stream: string) => (await redis.xrevrange(stream, '+', '-', 'COUNT', 2000)).filter(([, f]) => f[1] === rows[0]!.id);
      const queued = await mine(RENDER_STREAM);
      expect(queued).toHaveLength(1);
      expect(JSON.parse(queued[0]![1][3]!).payload).toEqual({ material_id: m.id, render_id: r.id, source_file_id: m.source, requested_by: supervisor.id });
      expect(await mine(MEDIA_STREAM)).toHaveLength(0);
      const all = JSON.stringify([inbox, await events(r.id), await events(r3.id), queued]);
      expect(all).not.toContain(CANARY);
      expect(all).not.toContain(CITY);
    } finally {
      redis.disconnect();
    }
  });

  it('issues an audited link to the request roles only, and refuses it once the material falls out of the conditions', async () => {
    const m = await ready();
    const r = (await as(supervisor).post(`/materials/${m.id}/renders`, body()).expect(202)).body;
    await worker.post(`/renders/${r.id}/start`).expect(204);
    const file = (await register(m.source, m.id, r.id).expect(200)).body.file_id as string;
    const url = `/materials/${m.id}/files/${file}/download-url`;

    const link = await as(supervisor).get(url).expect(200);
    expect(link.headers['cache-control']).toBe('no-store');
    expect(link.body.url).toContain(`/media/derived/${m.id}/${m.source}/renders/${r.id}/`);
    await as(producer).get(url).expect(200);
    await as(chief).get(url).expect(200);
    await as(reporter).get(url).expect(404);
    await as(rights).get(url).expect(404);
    await as(admin).get(url).expect(404);
    await as(otherSupervisor).get(url).expect(404);
    const audit = await h.pool.query(`SELECT actor_id, details FROM audit_log WHERE action = 'material_file.download_url_issued' AND target_id = $1`, [file]);
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows[0].details).toEqual({ material_id: m.id, file_id: file });

    await setStates(m.id, 'accepted', 'blocked');
    expect((await as(supervisor).get(url).expect(409)).body).toMatchObject({ code: 'render_not_allowed', details: { failed: ['rights_state'] } });
    await setStates(m.id, 'inbox', 'documented');
    expect((await as(supervisor).get(url).expect(409)).body.details).toEqual({ failed: ['editorial_state'] });
    await as(producer).get(url).expect(404);
  });

  describe('with MEDIA_ENABLE_RENDERS off (the default)', () => {
    let off: Harness;
    beforeAll(async () => {
      off = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
    });
    afterAll(() => off.close());

    it('answers 404 on both public endpoints', async () => {
      const m = await ready();
      const t = (await loginAs(off, [{ role: 'editor_in_chief' }])).token;
      const offHttp = () => request(off.app.getHttpServer());
      await offHttp().get(`/v1/materials/${m.id}/renders`).set('Authorization', `Bearer ${t}`).expect(404);
      await offHttp().post(`/v1/materials/${m.id}/renders`).set('Authorization', `Bearer ${t}`).set('Idempotency-Key', randomUUID()).send(body()).expect(404);
    });
  });
});
