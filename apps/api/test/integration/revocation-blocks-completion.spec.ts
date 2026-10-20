import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { UploadReconciler } from '../../src/uploads/upload-reconciler';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

/** تخزين بديل: كل كائن رفع موجود بالحجم المطلوب. */
class FakeStorage implements ObjectStorage {
  sizes = new Map<string, number>();
  async head(_bucket: string, key: string) {
    const size = this.sizes.get(key);
    return size === undefined ? null : { size };
  }
  async read(): Promise<never> {
    throw new Error('not used');
  }
}

/**
 * إبطال وصول المستخدم أثناء رفع جارٍ (قياس #68): لا يكتمل الرفع ولا يصدر إيصال ولا حدث وسائط، في كل نقطة اكتمال:
 * الإبطال نفسه، وخطّاف post-finish، والتسوية، ونتيجة التحقق من العامل.
 */
describe('revocation blocks upload completion', () => {
  const storage = new FakeStorage();
  const workerToken = randomBytes(32).toString('base64url');
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ env: { MEDIA_WORKER_TOKEN: workerToken }, overrides: [[OBJECT_STORAGE, storage]] });
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const postFinish = (sessionId: string) =>
    http()
      .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
      .send({
        Type: 'post-finish',
        Event: {
          Upload: {
            ID: `${sessionId}+multipart-id`,
            Size: 1000,
            Offset: 1000,
            MetaData: { upload_session_id: sessionId },
            Storage: { Type: 's3store', Bucket: h.config.S3_BUCKET_UPLOADS, Key: `${h.config.TUSD_OBJECT_PREFIX}${sessionId}` },
          },
          HTTPRequest: { Method: 'PATCH', URI: `/files/${sessionId}`, Header: {} },
        },
      });
  const logoutEverywhere = (token: string) => http().post('/v1/auth/logout').set('Authorization', `Bearer ${token}`).send({ all_sessions: true }).expect(204);
  const session = async (id: string) =>
    (await h.pool.query(`SELECT state, failure_reason, upload_token_hash, file_id FROM upload_sessions WHERE id = $1`, [id])).rows[0];
  const events = async (id: string) => (await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [id])).rows;
  const files = async (materialId: string) =>
    (await h.pool.query(`SELECT id, receipt_number FROM material_files WHERE material_id = $1`, [materialId])).rows;
  const audits = async (id: string) => (await h.pool.query(`SELECT actor_id, action, details FROM audit_log WHERE target_id = $1`, [id])).rows;
  const inProgress = async (reporterId: string) => {
    const s = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    await h.pool.query(`UPDATE upload_sessions SET storage_key = $2 WHERE id = $1`, [s.id, `${h.config.TUSD_OBJECT_PREFIX}${s.id}`]);
    storage.sizes.set(`${h.config.TUSD_OBJECT_PREFIX}${s.id}`, 1000);
    return s;
  };

  it('revoking every session mid-upload fails the upload at once; the late post-finish completes nothing', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const s = await inProgress(reporter.id);
    await logoutEverywhere(reporter.token);

    expect(await session(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted', upload_token_hash: null, file_id: null });
    await postFinish(s.id).expect(200);
    expect(await session(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
    expect((await events(s.id)).map((e) => e.type)).toEqual(['upload.failed']);
    expect((await events(s.id))[0].payload).toEqual({ material_id: s.materialId, upload_session_id: s.id, kind: 'original', failure_reason: 'aborted' });
    expect(await files(s.materialId)).toEqual([]);
    // التدقيق بالمعرّفات وحدها
    expect(await audits(s.id)).toEqual([
      {
        actor_id: null,
        action: 'upload.aborted_access_revoked',
        details: { upload_session_id: s.id, material_id: s.materialId, target_user_id: reporter.id, reason_code: 'access_revoked' },
      },
    ]);
  });

  it('post-finish refuses completion for a suspended owner even if the session was not aborted yet', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const s = await inProgress(reporter.id);
    // تعليق خارج revokeAllAccess (مثل تعديل تشغيلي): الفحص عند الاكتمال يكفي وحده
    await h.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [reporter.id]);
    await postFinish(s.id).expect(200);
    expect(await session(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
    expect((await events(s.id)).map((e) => e.type)).toEqual(['upload.failed']);
  });

  it('post-finish refuses completion when the upload token was revoked', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const s = await inProgress(reporter.id);
    await h.pool.query(`UPDATE upload_sessions SET upload_token_hash = NULL WHERE id = $1`, [s.id]);
    await postFinish(s.id).expect(200);
    expect(await session(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
  });

  it('the reconciler does not mark a lost post-finish received for a revoked owner', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    await h.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [reporter.id]);
    // updated_at يُضبط عند الإدراج وحده (المحفّز يعيده إلى now() عند كل تحديث)
    const s = await seedUploadSession(h, reporter.id, { state: 'in_progress', updatedSecondsAgo: h.config.UPLOAD_RECONCILE_STALE_SECONDS + 60 });
    storage.sizes.set(`${h.config.TUSD_OBJECT_PREFIX}${s.id}`, 1000);
    const reconciler = h.app.get(UploadReconciler);
    for (let i = 0; i < 20 && (await session(s.id)).state === 'in_progress'; i++) await reconciler.reconcileBatch(500);
    expect(await session(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
    expect((await events(s.id)).map((e) => e.type)).toEqual(['upload.failed']);
  });

  it('a completed upload awaiting verification is aborted by the revocation; the worker result issues no receipt', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const s = await inProgress(reporter.id);
    await postFinish(s.id).expect(200);
    expect((await session(s.id)).state).toBe('completed');
    await logoutEverywhere(reporter.token);
    expect(await session(s.id)).toMatchObject({ state: 'failed', failure_reason: 'aborted' });
    const { rows: m } = await h.pool.query(`SELECT technical_state FROM materials WHERE id = $1`, [s.materialId]);
    expect(m[0].technical_state).toBe('failed');

    const report = {
      result: 'verified',
      sha256: randomBytes(32).toString('hex'),
      size_bytes: 1000,
      head_sha256: randomBytes(32).toString('hex'),
      tail_sha256: randomBytes(32).toString('hex'),
      technical: { duration_ms: 1000, start_pts_us: 0 },
    };
    const res = await http()
      .post(`/internal/media/sessions/${s.id}/verification`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send(report)
      .expect(200);
    expect(res.body).toEqual({ state: 'failed', file_id: null, receipt_number: null, failure_reason: 'aborted' });
    expect(await files(s.materialId)).toEqual([]);
    expect((await events(s.id)).map((e) => e.type)).toEqual(['upload.original_received', 'upload.failed']);
  });

  it('a worker result for a completed session whose owner was suspended outside the revocation is refused too', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const s = await inProgress(reporter.id);
    await postFinish(s.id).expect(200);
    await h.pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [reporter.id]);
    const res = await http()
      .post(`/internal/media/sessions/${s.id}/verification`)
      .set('Authorization', `Bearer ${workerToken}`)
      .send({
        result: 'verified',
        sha256: randomBytes(32).toString('hex'),
        size_bytes: 1000,
        head_sha256: randomBytes(32).toString('hex'),
        tail_sha256: randomBytes(32).toString('hex'),
        technical: { duration_ms: 1000, start_pts_us: 0 },
      })
      .expect(200);
    expect(res.body).toMatchObject({ state: 'failed', receipt_number: null, failure_reason: 'aborted' });
    expect(await files(s.materialId)).toEqual([]);
    expect((await events(s.id)).map((e) => e.type)).not.toContain('upload.verified');
  });

  it('a revocation does not touch uploads that were already verified', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const s = await seedUploadSession(h, reporter.id, { state: 'verified' });
    await logoutEverywhere(reporter.token);
    expect((await session(s.id)).state).toBe('verified');
  });
});
