import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

class RecordingStorage implements ObjectStorage {
  removed: string[] = [];
  fail = false;
  async head() {
    return null;
  }
  async read() {
    return Readable.from([]);
  }
  async removeUpload(bucket: string, key: string) {
    if (this.fail) throw new Error('storage down');
    this.removed.push(`${bucket}/${key}`);
  }
}

// إدارة جلسات الرفع (#151 البند 2): قائمة جلسات المستدعي للاستئناف، وإلغاء جلسة جارية
describe('upload sessions: list mine and cancel (GET /uploads, DELETE /uploads/{id})', () => {
  const storage = new RecordingStorage();
  let h: Harness;
  let reporter: Actor;
  let other: Actor;
  beforeAll(async () => {
    h = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
    reporter = await loginAs(h, [{ role: 'reporter' }]);
    other = await loginAs(h, [{ role: 'reporter' }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const list = (a: Actor, query = '') => http().get(`/v1/uploads${query}`).set('Authorization', `Bearer ${a.token}`);
  const cancel = (a: Actor, id: string, key = randomUUID()) =>
    http().delete(`/v1/uploads/${id}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key);
  const row = async (id: string) => (await h.pool.query(`SELECT * FROM upload_sessions WHERE id = $1`, [id])).rows[0];
  const failedEvents = async (id: string) =>
    (await h.pool.query(`SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND type = 'upload.failed'`, [id])).rows.map((r) => r.payload);
  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((s) => s.id);

  describe('GET /uploads', () => {
    let mine: Actor;
    beforeAll(async () => {
      mine = await loginAs(h, [{ role: 'reporter' }]);
    });

    it('lists the caller sessions only, newest first, non-terminal by default, without the upload token', async () => {
      const a = await seedUploadSession(h, mine.id, { state: 'created' });
      const b = await seedUploadSession(h, mine.id, { state: 'in_progress' });
      const c = await seedUploadSession(h, mine.id, { state: 'completed' });
      const failed = await seedUploadSession(h, mine.id, { state: 'in_progress' });
      await h.pool.query(`UPDATE upload_sessions SET state = 'failed', failure_reason = 'expired' WHERE id = $1`, [failed.id]);
      await seedUploadSession(h, other.id, { state: 'in_progress' });
      const res = await list(mine).expect(200);
      const valid = schemaValidator('UploadSessionPage');
      expect(valid(res.body) ? [] : valid.errors).toEqual([]);
      expect(ids(res.body)).toEqual([c.id, b.id, a.id]);
      expect(ids(res.body)).not.toContain(failed.id);
      expect(JSON.stringify(res.body)).not.toContain('upload_token');
      expect(res.body.next_cursor).toBeNull();
    });

    it('filters by state and by material, and pages with the cursor without gaps', async () => {
      const filtered = await loginAs(h, [{ role: 'reporter' }]);
      const sessions: Array<Awaited<ReturnType<typeof seedUploadSession>>> = [];
      for (let i = 0; i < 5; i++) sessions.push(await seedUploadSession(h, filtered.id, { state: 'in_progress' }));
      await h.pool.query(`UPDATE upload_sessions SET state = 'verified' WHERE id = $1`, [sessions[0]!.id]);
      const newestFirst = sessions.map((s) => s.id).reverse();

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Array<{ id: string }>; next_cursor: string | null } = (await list(filtered, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...ids(page));
        cursor = page.next_cursor;
      } while (cursor);
      const inflight = newestFirst.filter((id) => id !== sessions[0]!.id);
      expect(seen).toEqual(inflight);

      const one = sessions[2]!;
      expect(ids((await list(filtered, `?material_id=${one.materialId}`).expect(200)).body)).toEqual([one.id]);
      const all = (await list(filtered, '?state=in_progress&state=verified&limit=50').expect(200)).body;
      expect(ids(all).sort()).toEqual(sessions.map((s) => s.id).sort());
      const single = (await list(filtered, '?state=in_progress&limit=50').expect(200)).body;
      expect(ids(single)).toEqual(inflight);
    });

    it('rejects an invalid cursor or state with 400, including a well-formed cursor whose time is out of range', async () => {
      expect((await list(reporter, '?cursor=not-a-cursor').expect(400)).body.code).toBe('bad_request');
      await list(reporter, '?state=bogus').expect(400);
      const cursor = (at: string) => Buffer.from(JSON.stringify([at, randomUUID()])).toString('base64url');
      for (const at of ['2026-13-40 25:61:61+00', '2026-02-30T00:00:00Z', 'Oct 21 2026', '2026-10-21']) {
        expect([at, (await list(reporter, `?cursor=${cursor(at)}`)).status]).toEqual([at, 400]);
      }
      await list(reporter, `?cursor=${cursor('2026-10-21 23:00:00.123456+00')}`).expect(200);
    });

    it('sessions created in the same microsecond page by id without gaps or repeats', async () => {
      const tied = await loginAs(h, [{ role: 'reporter' }]);
      const sessions: string[] = [];
      for (let i = 0; i < 4; i++) sessions.push((await seedUploadSession(h, tied.id, { state: 'in_progress' })).id);
      await h.pool.query(`UPDATE upload_sessions SET created_at = '2026-10-21 12:00:00.123456+00' WHERE id = ANY($1::uuid[])`, [sessions]);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Array<{ id: string }>; next_cursor: string | null } = (await list(tied, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
        seen.push(...ids(page));
        cursor = page.next_cursor;
      } while (cursor);
      expect(seen).toEqual([...sessions].sort().reverse());
    });
  });

  describe('DELETE /uploads/{id}', () => {
    it('cancels an in-progress session: failed/aborted, token revoked, upload.failed, temporary storage removed; repeating is 204 with no new event', async () => {
      storage.removed = [];
      const s = await seedUploadSession(h, reporter.id, { state: 'in_progress' });
      await cancel(reporter, s.id).expect(204);
      expect(await row(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted', upload_token_hash: null, upload_token_expires_at: null });
      expect(await failedEvents(s.id)).toEqual([{ material_id: s.materialId, upload_session_id: s.id, kind: 'original', failure_reason: 'aborted' }]);
      expect(storage.removed).toEqual([`${h.config.S3_BUCKET_UPLOADS}/${h.config.TUSD_OBJECT_PREFIX}${s.id}`]);

      await cancel(reporter, s.id).expect(204);
      expect(await failedEvents(s.id)).toHaveLength(1);
      // لا يعود في القائمة الافتراضية، ويظهر بحالته عند طلبها
      expect(ids((await list(reporter).expect(200)).body)).not.toContain(s.id);
      const failed = (await list(reporter, `?state=failed&material_id=${s.materialId}`).expect(200)).body.items[0];
      expect(failed).toMatchObject({ id: s.id, state: 'failed', failure_reason: 'aborted' });
    });

    it('a cancelled session accepts no upload token, and its late post-receive and post-finish have no effect', async () => {
      const s = await seedUploadSession(h, reporter.id, { state: 'created' });
      await cancel(reporter, s.id).expect(204);
      const hook = (Type: string) =>
        http()
          .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
          .send({
            Type,
            Event: {
              Upload: { ID: s.id, Size: 1000, Offset: 1000, MetaData: { upload_session_id: s.id }, Storage: { Type: 's3store', Bucket: h.config.S3_BUCKET_UPLOADS, Key: `${h.config.TUSD_OBJECT_PREFIX}${s.id}` } },
              HTTPRequest: { Header: { Authorization: [`Bearer ${s.uploadToken}`] } },
            },
          })
          .expect(200);
      expect((await hook('pre-create')).body.RejectUpload).toBe(true);
      // تقدّم يصل بعد الإلغاء (ADR 0024): لا مستلم ولا حدث upload.progress
      await hook('post-receive');
      expect((await row(s.id)).bytes_received).toBe('0');
      const progress = await h.pool.query(`SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND type = 'upload.progress'`, [s.id]);
      expect(progress.rows).toEqual([]);
      await hook('post-finish');
      expect(await row(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
      const { rows } = await h.pool.query(`SELECT type FROM outbox_events WHERE aggregate_id = $1 AND type LIKE 'upload.%received'`, [s.id]);
      expect(rows).toEqual([]);
    });

    it('cancelling a completed original before verification returns the material technical track to failed, with no file row left', async () => {
      const s = await seedUploadSession(h, reporter.id, { state: 'completed' });
      await h.pool.query(`UPDATE materials SET technical_state = 'original_received' WHERE id = $1`, [s.materialId]);
      await cancel(reporter, s.id).expect(204);
      const { rows } = await h.pool.query(`SELECT technical_state FROM materials WHERE id = $1`, [s.materialId]);
      expect(rows[0].technical_state).toBe('failed');
      // صف الملف يُنشأ عند التحقق لا عند الاستلام، والمتحقق منه لا يُلغى: لا صف يشير إلى كائن محذوف
      const files = await h.pool.query(`SELECT 1 FROM material_files WHERE material_id = $1`, [s.materialId]);
      expect(files.rows).toEqual([]);
    });

    it('cancel racing a late post-finish: one wins under the row lock, never a received upload left on a cancelled session', async () => {
      for (let round = 0; round < 8; round++) {
        const s = await seedUploadSession(h, reporter.id, { state: 'in_progress' });
        const finish = http()
          .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
          .send({
            Type: 'post-finish',
            Event: {
              Upload: { ID: s.id, Size: 1000, Offset: 1000, MetaData: { upload_session_id: s.id }, Storage: { Type: 's3store', Bucket: h.config.S3_BUCKET_UPLOADS, Key: `${h.config.TUSD_OBJECT_PREFIX}${s.id}` } },
              HTTPRequest: { Header: {} },
            },
          });
        const [c, f] = await Promise.all([cancel(reporter, s.id), finish]);
        expect([c.status, f.status]).toEqual([204, 200]);
        // الترتيبان: الإلغاء أولًا فالخطّاف بلا أثر، أو الاستلام أولًا فالإلغاء يُفشل المكتمل. في الحالتين النهاية failed/aborted
        expect(await row(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
        const { rows } = await h.pool.query(`SELECT type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [s.id]);
        const types = rows.map((r) => r.type);
        expect(types[types.length - 1]).toBe('upload.failed');
      }
    });

    it('a verified upload is 409; someone else’s session and a malformed id are 404; a storage failure does not fail the cancel', async () => {
      const verified = await seedUploadSession(h, reporter.id, { state: 'verified' });
      expect((await cancel(reporter, verified.id).expect(409)).body.code).toBe('upload_state_conflict');
      expect((await row(verified.id)).state).toBe('verified');

      const theirs = await seedUploadSession(h, other.id, { state: 'in_progress' });
      await cancel(reporter, theirs.id).expect(404);
      expect((await row(theirs.id)).state).toBe('in_progress');
      await cancel(reporter, 'not-a-uuid').expect(404);

      storage.fail = true;
      try {
        const s = await seedUploadSession(h, reporter.id, { state: 'in_progress' });
        await cancel(reporter, s.id).expect(204);
        expect((await row(s.id)).state).toBe('failed');
      } finally {
        storage.fail = false;
      }
    });
  });
});
