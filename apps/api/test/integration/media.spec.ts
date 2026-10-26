import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { MEDIA_STREAM } from '../../src/outbox/media-stream';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, drainOutbox, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

/** تخزين بديل بحاويتين: كائنات الرفع في uploads والمشتقات في media، كل مفتاح في حاويته. */
class FakeStorage implements ObjectStorage {
  sizes = new Map<string, number>();
  async head(bucket: string, key: string) {
    const expected = key.startsWith('derived/') ? 'media' : 'uploads';
    const size = bucket === expected ? this.sizes.get(key) : undefined;
    return size === undefined ? null : { size };
  }
  async read(): Promise<never> {
    throw new Error('not used');
  }
}

const hex = (b: Buffer) => b.toString('hex');
const technical = {
  duration_ms: 4000,
  start_pts_us: 10_000_000,
  width: 1280,
  height: 720,
  container: 'mov',
  video_codec: 'h264',
  audio_codec: 'aac',
  frame_rate: 29.97,
  avg_frame_rate: 28.1,
  vfr: true,
  frame_count: 112,
  max_frame_gap_ms: 600,
  has_gaps: true,
  rotation: 90,
  hdr: false,
  bit_depth: 8,
  audio_sample_rate: 48000,
  audio_channels: 2,
};

describe('media worker interface (/internal/media/*, ADR 0006)', () => {
  const storage = new FakeStorage();
  const token = randomBytes(32).toString('base64url');
  const aiToken = randomBytes(32).toString('base64url');
  let h: Harness;
  let reporterId: string;
  beforeAll(async () => {
    h = await createHarness({ env: { MEDIA_WORKER_TOKEN: token, AI_WORKER_TOKEN: aiToken }, overrides: [[OBJECT_STORAGE, storage]] });
    reporterId = (await seedUser(h)).id;
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const auth = (r: request.Test, t = token) => r.set('Authorization', `Bearer ${t}`);
  const getSession = (id: string, t?: string) => auth(http().get(`/internal/media/sessions/${id}`), t);
  const verify = (id: string, body: object) => auth(http().post(`/internal/media/sessions/${id}/verification`)).send(body);
  const derive = (fileId: string, body: object) => auth(http().post(`/internal/media/files/${fileId}/derivatives`)).send(body);

  /** جلسة completed كما يتركها post-finish، وكائنها في التخزين. */
  const completed = async (opts: { size?: number; clientSha?: Buffer; stored?: number | null; kind?: string } = {}) => {
    const size = opts.size ?? 5000;
    const s = await seedUploadSession(h, reporterId, { size, kind: opts.kind });
    await h.pool.query(`UPDATE upload_sessions SET state = 'completed', storage_key = $2, client_sha256 = $3 WHERE id = $1`, [s.id, `tus/${s.id}`, opts.clientSha ?? null]);
    await h.pool.query(`UPDATE materials SET technical_state = 'original_received' WHERE id = $1`, [s.materialId]);
    if (opts.stored !== null) storage.sizes.set(`tus/${s.id}`, opts.stored ?? size);
    return s;
  };
  const report = (size = 5000, sha = randomBytes(32)) => ({
    result: 'verified',
    sha256: hex(sha),
    size_bytes: size,
    head_sha256: hex(randomBytes(32)),
    tail_sha256: hex(randomBytes(32)),
    technical,
  });

  describe('authentication', () => {
    it('a missing or wrong token, or a server without one, is 404; not reachable under /v1', async () => {
      const s = await completed();
      await http().get(`/internal/media/sessions/${s.id}`).expect(404);
      await getSession(s.id, 'x'.repeat(43)).expect(404);
      await getSession(s.id).expect(200);
      await auth(http().get(`/v1/internal/media/sessions/${s.id}`)).expect(404);
      const none = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
      try {
        await request(none.app.getHttpServer()).get(`/internal/media/sessions/${s.id}`).set('Authorization', 'Bearer ').expect(404);
      } finally {
        await none.close();
      }
    });
  });

  describe('GET /internal/media/sessions/{id}', () => {
    it('returns what the worker needs and never the client checksum', async () => {
      const s = await completed({ clientSha: randomBytes(32) });
      const res = await getSession(s.id).expect(200);
      expect(res.body).toEqual({
        material_id: s.materialId,
        kind: 'original',
        state: 'completed',
        size_bytes: 5000,
        storage_key: `tus/${s.id}`,
        proxy_mode: null,
        material_has_proxy: false,
        proxy_file_id: null,
        original_file_id: null,
      });
      // v0.1: الرمز صحيح والجلسة غير موجودة = 410 media_resource_gone (حدث متقادم)، والرمز الخاطئ يبقى 404
      const gone = '00000000-0000-4000-8000-000000000000';
      expect((await getSession(gone).expect(410)).body.code).toBe('media_resource_gone');
      expect((await getSession('not-a-uuid').expect(410)).body.code).toBe('media_resource_gone');
      expect((await verify(gone, report()).expect(410)).body.code).toBe('media_resource_gone');
      await getSession(gone, 'x'.repeat(43)).expect(404);
      await auth(http().post(`/internal/media/sessions/${gone}/verification`), 'x'.repeat(43)).send(report()).expect(404);
    });
  });

  describe('POST /internal/media/sessions/{id}/verification', () => {
    it('verifies: receipt, technical data split into columns and the whitelisted json, idempotent repeat, conflicting repeat 409', async () => {
      const sha = randomBytes(32);
      const s = await completed({ clientSha: sha });
      const body = report(5000, sha);
      const res = await verify(s.id, body).expect(200);
      expect(res.body).toMatchObject({ state: 'verified', failure_reason: null });
      expect(res.body.receipt_number).toMatch(/^R-\d{6}-\d{6}$/);
      const { rows } = await h.pool.query(`SELECT * FROM material_files WHERE id = $1`, [res.body.file_id]);
      const { duration_ms, start_pts_us, width, height, ...json } = technical;
      expect(rows[0]).toMatchObject({ duration_ms: String(duration_ms), start_pts_us: String(start_pts_us), width, height, technical: json });
      expect(hex(rows[0].sha256)).toBe(hex(sha));
      expect(hex(rows[0].head_sha256)).toBe(body.head_sha256);
      const { rows: ev } = await h.pool.query(`SELECT type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [s.id]);
      expect(ev.map((e) => e.type)).toEqual(['upload.verified']);

      expect((await verify(s.id, body).expect(200)).body).toEqual(res.body);
      expect((await verify(s.id, report(5000)).expect(409)).body.code).toBe('upload_state_conflict');
      expect((await verify(s.id, { result: 'invalid_file' }).expect(409)).body.code).toBe('upload_state_conflict');
    });

    it('the server decides checksum_mismatch against the client checksum, and invalid_file on a size that differs from the session or storage', async () => {
      const mismatch = await completed({ clientSha: randomBytes(32) });
      const r1 = await verify(mismatch.id, report()).expect(200);
      expect(r1.body).toEqual({ state: 'failed', file_id: null, receipt_number: null, failure_reason: 'checksum_mismatch' });
      expect((await verify(mismatch.id, report()).expect(200)).body).toEqual(r1.body);

      const wrongSize = await completed();
      expect((await verify(wrongSize.id, report(4999)).expect(200)).body.failure_reason).toBe('invalid_file');
      const truncated = await completed({ stored: 4000 });
      expect((await verify(truncated.id, report()).expect(200)).body.failure_reason).toBe('invalid_file');
      const missing = await completed({ stored: null });
      expect((await verify(missing.id, report()).expect(200)).body.failure_reason).toBe('storage_error');
    });

    it.each(['invalid_file', 'storage_error'] as const)('a final %s from the worker fails the session (it does not stay completed)', async (reason) => {
      const s = await completed();
      expect((await verify(s.id, { result: reason }).expect(200)).body).toEqual({ state: 'failed', file_id: null, receipt_number: null, failure_reason: reason });
      // الجلسة لم تعد completed فلا يعيدها الطابور ولا المُتحقق داخل الخادم، والأصل يفشل في المسار الفني
      expect((await getSession(s.id).expect(200)).body.state).toBe('failed');
      const { rows: m } = await h.pool.query(`SELECT technical_state FROM materials WHERE id = $1`, [s.materialId]);
      expect(m[0].technical_state).toBe('failed');
      const { rows: ev } = await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [s.id]);
      expect(ev).toEqual([{ type: 'upload.failed', payload: { material_id: s.materialId, upload_session_id: s.id, kind: 'original', failure_reason: reason } }]);
      // التكرار يعيد النتيجة نفسها، والنتيجة المخالفة 409
      expect((await verify(s.id, { result: reason }).expect(200)).body.failure_reason).toBe(reason);
      const other = reason === 'invalid_file' ? 'storage_error' : 'invalid_file';
      expect((await verify(s.id, { result: other }).expect(409)).body.code).toBe('upload_state_conflict');
    });

    it('rejects bodies outside the closed schema (422) before touching the session, and sessions not completed (409)', async () => {
      const s = await completed();
      for (const bad of [
        { ...report(), technical: { ...technical, location: '+31.77+035.23/' } },
        { ...report(), make: 'TestMaker' },
        { result: 'verified', sha256: hex(randomBytes(32)) },
        { result: 'invalid_file', sha256: hex(randomBytes(32)) },
        { ...report(), sha256: 'ABC' },
      ]) {
        expect((await verify(s.id, bad).expect(422)).body.code).toBe('validation_failed');
      }
      expect((await getSession(s.id).expect(200)).body.state).toBe('completed');
      const fresh = await seedUploadSession(h, reporterId);
      await verify(fresh.id, report(1000)).expect(409);
    });
  });

  describe('AI_WORKER_TOKEN (local transcription worker)', () => {
    it('is refused (404) everywhere except derivatives of kind transcript, captions or shot_list', async () => {
      const s = await completed();
      await getSession(s.id, aiToken).expect(404);
      await auth(http().post(`/internal/media/sessions/${s.id}/verification`), aiToken).send(report()).expect(404);
      const fileId = (await verify(s.id, report()).expect(200)).body.file_id as string;
      const derived = (kind: string, t: string) =>
        auth(http().post(`/internal/media/files/${fileId}/derivatives`), t).send({
          kind,
          storage_key: `derived/${s.materialId}/${fileId}/${kind}.vtt`,
          sha256: hex(randomBytes(32)),
          size_bytes: 10,
          technical: { duration_ms: 1000, start_pts_us: 0 },
        });
      for (const kind of ['proxy', 'thumbnail', 'hls', 'audio']) await derived(kind, aiToken).expect(404);
      // للأنواع المسموحة يتجاوز الرمز المصادقة ويلقى ما يلقاه رمز عامل الوسائط نفسه (التحقق بمخطط العقد بعدها)
      for (const kind of ['transcript', 'captions', 'shot_list']) {
        const viaAi = await derived(kind, aiToken);
        expect(viaAi.status).not.toBe(404);
        expect(viaAi.status).toBe((await derived(kind, token)).status);
        await derived(kind, 'x'.repeat(43)).expect(404);
      }
    });
  });

  describe('POST /internal/media/files/{file_id}/derivatives', () => {
    const verifiedOriginal = async () => {
      const s = await completed();
      const fileId = (await verify(s.id, report()).expect(200)).body.file_id as string;
      return { ...s, fileId };
    };
    const proxy = (materialId: string, fileId: string, sha = randomBytes(32)) => {
      const key = `derived/${materialId}/${fileId}/proxy-480p.mp4`;
      storage.sizes.set(key, 900);
      return { kind: 'proxy', storage_key: key, sha256: hex(sha), size_bytes: 900, technical: { ...technical, width: 854, height: 480 } };
    };

    it('creates one proxy per source, idempotently; a different one is 409; the material then has a proxy', async () => {
      const o = await verifiedOriginal();
      const body = proxy(o.materialId, o.fileId);
      const first = await derive(o.fileId, body).expect(200);
      expect((await derive(o.fileId, body).expect(200)).body).toEqual(first.body);
      expect((await derive(o.fileId, proxy(o.materialId, o.fileId)).expect(409)).body.code).toBe('upload_state_conflict');
      const { rows } = await h.pool.query(`SELECT kind, state, derived_from_id, proxy_mode, width, height, receipt_number FROM material_files WHERE id = $1`, [
        first.body.file_id,
      ]);
      expect(rows[0]).toEqual({ kind: 'proxy', state: 'verified', derived_from_id: o.fileId, proxy_mode: 'normal', width: 854, height: 480, receipt_number: null });
      const another = await completed();
      await h.pool.query(`UPDATE upload_sessions SET material_id = $2 WHERE id = $1`, [another.id, o.materialId]);
      expect((await getSession(another.id).expect(200)).body.material_has_proxy).toBe(true);
    });

    it('registers a thumbnail beside the proxy: dimensions without duration, its mime type, no proxy_mode; one without dimensions is 422', async () => {
      const o = await verifiedOriginal();
      const key = `derived/${o.materialId}/${o.fileId}/poster.jpg`;
      storage.sizes.set(key, 120);
      const thumb = { kind: 'thumbnail', storage_key: key, sha256: hex(randomBytes(32)), size_bytes: 120, mime_type: 'image/jpeg', technical: { width: 640, height: 360 } };
      await derive(o.fileId, proxy(o.materialId, o.fileId)).expect(200);
      const res = await derive(o.fileId, thumb).expect(200);
      const { rows } = await h.pool.query(`SELECT kind, mime_type, proxy_mode, width, height, duration_ms FROM material_files WHERE id = $1`, [res.body.file_id]);
      expect(rows[0]).toEqual({ kind: 'thumbnail', mime_type: 'image/jpeg', proxy_mode: null, width: 640, height: 360, duration_ms: null });
      await derive(o.fileId, { ...thumb, technical: {} }).expect(422);
      await derive(o.fileId, { ...thumb, mime_type: undefined }).expect(422);
    });

    it('looks the derivative up in the media bucket (S3_BUCKET_MEDIA), not the uploads bucket', async () => {
      expect(h.config.S3_BUCKET_MEDIA).toBe('media');
      expect(h.config.S3_BUCKET_MEDIA).not.toBe(h.config.S3_BUCKET_UPLOADS);
      const o = await verifiedOriginal();
      const head = jest.spyOn(storage, 'head');
      try {
        await derive(o.fileId, proxy(o.materialId, o.fileId)).expect(200);
        expect(head).toHaveBeenLastCalledWith('media', expect.stringMatching(/^derived\//));
      } finally {
        head.mockRestore();
      }
    });

    it('a verified voice note is a source for audio, transcript and captions only; an unverified one is not', async () => {
      const o = await verifiedOriginal();
      const note = async (state: string) =>
        (
          await h.pool.query<{ id: string }>(
            `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at)
             VALUES ($1, 'voice_note', $2, 800, $3, $4, CASE WHEN $2 = 'verified' THEN now() END) RETURNING id`,
            [o.materialId, state, randomBytes(32), `tus/${randomBytes(8).toString('hex')}`],
          )
        ).rows[0]!.id;
      const v = await note('verified');
      const body = (kind: string, mime: string) => {
        const key = `derived/${o.materialId}/${v}/${kind}`;
        storage.sizes.set(key, 40);
        return { kind, storage_key: key, sha256: hex(randomBytes(32)), size_bytes: 40, mime_type: mime, technical: { duration_ms: 1000, start_pts_us: 0 } };
      };
      for (const [kind, mime] of [['audio', 'audio/mp4'], ['transcript', 'application/json'], ['captions', 'text/vtt']] as const) {
        const res = await derive(v, body(kind, mime)).expect(200);
        const { rows } = await h.pool.query(`SELECT kind, derived_from_id FROM material_files WHERE id = $1`, [res.body.file_id]);
        expect(rows[0]).toEqual({ kind, derived_from_id: v });
      }
      expect((await derive(v, proxy(o.materialId, v)).expect(409)).body.code).toBe('upload_state_conflict');
      const pending = await note('received');
      const key = `derived/${o.materialId}/${pending}/transcript`;
      storage.sizes.set(key, 40);
      await derive(pending, { kind: 'transcript', storage_key: key, sha256: hex(randomBytes(32)), size_bytes: 40, mime_type: 'application/json', technical: { duration_ms: 1000, start_pts_us: 0 } }).expect(409);
    });

    it('refuses keys outside the derived prefix of the source, a missing object, a non-original source, and unknown files', async () => {
      const o = await verifiedOriginal();
      const other = await verifiedOriginal();
      for (const storage_key of [`derived/${other.materialId}/${other.fileId}/p.mp4`, `tus/${o.id}`, `derived/${o.materialId}/${o.fileId}/../x.mp4`]) {
        storage.sizes.set(storage_key, 900);
        await derive(o.fileId, { ...proxy(o.materialId, o.fileId), storage_key }).expect(422);
      }
      const body = proxy(o.materialId, o.fileId);
      storage.sizes.delete(body.storage_key);
      await derive(o.fileId, body).expect(422);
      const p = await derive(o.fileId, proxy(o.materialId, o.fileId)).expect(200);
      await derive(p.body.file_id, proxy(o.materialId, p.body.file_id)).expect(409);
      expect((await derive('00000000-0000-4000-8000-000000000000', proxy(o.materialId, o.fileId)).expect(410)).body.code).toBe('media_resource_gone');
      await auth(http().post('/internal/media/files/00000000-0000-4000-8000-000000000000/derivatives'), 'x'.repeat(43))
        .send(proxy(o.materialId, o.fileId))
        .expect(404);
    });
  });

  // المحاذاة الصوتية (v0.3، #249): العامل يقيسها حين يتحقق الثاني من النسخة الخفيفة والأصل، فيجد المقابل في الجلسة
  describe('PUT /internal/media/files/{file_id}/alignment', () => {
    const align = (fileId: string, body: object, t?: string) => auth(http().put(`/internal/media/files/${fileId}/alignment`), t).send(body);
    const measured = (originalId: string) => ({ original_file_id: originalId, offset_ms: -120, confidence: 0.93, margin: 0.41, reliable: true });
    const withProxy = async () => {
      const s = await completed();
      const originalId = (await verify(s.id, report()).expect(200)).body.file_id as string;
      const key = `derived/${s.materialId}/${originalId}/proxy-480p.mp4`;
      storage.sizes.set(key, 900);
      const proxyId = (
        await derive(originalId, { kind: 'proxy', storage_key: key, sha256: hex(randomBytes(32)), size_bytes: 900, technical: { ...technical, width: 854, height: 480 } }).expect(200)
      ).body.file_id as string;
      return { ...s, originalId, proxyId };
    };

    it('the session names the verified proxy and original of its material', async () => {
      const o = await withProxy();
      const res = await getSession(o.id).expect(200);
      expect(res.body).toMatchObject({ material_has_proxy: true, proxy_file_id: o.proxyId, original_file_id: o.originalId });
      const valid = schemaValidator('MediaSession');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    });

    it('records the measurement on the proxy idempotently (204), replaces it, and Material.files shows it on the proxy only', async () => {
      const o = await withProxy();
      await align(o.proxyId, measured(o.originalId)).expect(204);
      await align(o.proxyId, measured(o.originalId)).expect(204);
      await align(o.proxyId, { ...measured(o.originalId), offset_ms: 35, reliable: false }).expect(204);
      const chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
      const material = (await http().get(`/v1/materials/${o.materialId}`).set('Authorization', `Bearer ${chief.token}`).expect(200)).body;
      const files = material.files as Array<{ id: string; kind: string; alignment?: unknown }>;
      expect(files.find((f) => f.id === o.proxyId)!.alignment).toEqual({ original_file_id: o.originalId, offset_ms: 35, confidence: 0.93, margin: 0.41, reliable: false });
      expect(files.find((f) => f.id === o.originalId)).not.toHaveProperty('alignment');
      // المادة المزروعة عنوانها أقصر من حد العقد، فيُتحقق من ملفها بمخططه
      const valid = schemaValidator('MaterialFile');
      expect(valid(files.find((f) => f.id === o.proxyId)) ? [] : valid.errors).toEqual([]);
      const unmeasured = await withProxy();
      const other = (await http().get(`/v1/materials/${unmeasured.materialId}`).set('Authorization', `Bearer ${chief.token}`).expect(200)).body;
      expect(other.files.find((f: { id: string }) => f.id === unmeasured.proxyId).alignment).toBeNull();
    });

    it('refuses with 422 a file that is not a proxy and an original of another material; 410 for an unknown file; 404 without the token', async () => {
      const o = await withProxy();
      const other = await withProxy();
      expect((await align(o.originalId, measured(o.originalId)).expect(422)).body.code).toBe('validation_failed');
      expect(JSON.stringify((await align(o.proxyId, measured(other.originalId)).expect(422)).body)).toContain('/original_file_id');
      await align(o.proxyId, measured(o.proxyId)).expect(422);
      await align(o.proxyId, { ...measured(o.originalId), confidence: 1.5 }).expect(422);
      expect((await align('00000000-0000-4000-8000-000000000000', measured(o.originalId)).expect(410)).body.code).toBe('media_resource_gone');
      await align(o.proxyId, measured(o.originalId), 'x'.repeat(43)).expect(404);
      const { rows } = await h.pool.query(`SELECT alignment_offset_ms FROM material_files WHERE id = $1`, [o.proxyId]);
      expect(rows[0].alignment_offset_ms).toBeNull();
    });
  });

  it('upload.original_received is published to the media:events stream with event_id and the contract-shaped event', async () => {
    const redis = new Redis(h.config.REDIS_URL!);
    try {
      const s = await seedUploadSession(h, reporterId);
      await h.pool.query(`UPDATE upload_sessions SET state = 'in_progress', storage_key = $2 WHERE id = $1`, [s.id, `tus/${s.id}`]);
      await http()
        .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
        .send({
          Type: 'post-finish',
          Event: {
            Upload: { ID: s.id, Size: 1000, Offset: 1000, MetaData: { upload_session_id: s.id }, Storage: { Type: 's3store', Bucket: 'uploads', Key: `tus/${s.id}` } },
            HTTPRequest: { Method: 'PATCH', URI: `/files/${s.id}`, Header: {} },
          },
        })
        .expect(200);
      await drainOutbox(h);
      const { rows } = await h.pool.query<{ id: string }>(`SELECT id::text FROM outbox_events WHERE aggregate_id = $1 AND type = 'upload.original_received'`, [s.id]);
      const entries = await redis.xrevrange(MEDIA_STREAM, '+', '-', 'COUNT', 2000);
      const mine = entries.filter(([, fields]) => fields[1] === rows[0]!.id);
      expect(mine).toHaveLength(1);
      const [, fields] = mine[0]!;
      expect(fields[0]).toBe('event_id');
      expect(fields[2]).toBe('event');
      const event = JSON.parse(fields[3]!);
      expect(event).toMatchObject({
        id: rows[0]!.id,
        type: 'upload.original_received',
        aggregate_type: 'upload',
        aggregate_id: s.id,
        payload: { material_id: s.materialId, upload_session_id: s.id, kind: 'original' },
      });
      // لا كاشف في الطابور: الحمولة قائمة بيضاء
      expect(Object.keys(event.payload).sort()).toEqual(['kind', 'material_id', 'upload_session_id']);
    } finally {
      redis.disconnect();
    }
  });
});
