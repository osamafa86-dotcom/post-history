import request from 'supertest';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { UploadReconciler } from '../../src/uploads/upload-reconciler';
import { createHarness, type Harness, seedUploadSession, seedUser } from './harness';

/** تخزين بديل: الكائنات الموجودة بمفاتيحها، ووضع عطل. */
class FakeStorage implements ObjectStorage {
  keys = new Set<string>();
  failing = false;
  async head(_bucket: string, key: string) {
    if (this.failing) throw new Error('storage down');
    return this.keys.has(key) ? { size: 1000 } : null;
  }
  async read(): Promise<never> {
    throw new Error('not used');
  }
}

describe('upload reconciliation (in_progress sessions whose post-finish was lost)', () => {
  const storage = new FakeStorage();
  let h: Harness;
  let reconciler: UploadReconciler;
  let reporterId: string;
  beforeAll(async () => {
    h = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
    reconciler = h.app.get(UploadReconciler);
    reporterId = (await seedUser(h)).id;
  });
  afterAll(() => h.close());
  beforeEach(() => {
    storage.failing = false;
  });

  const stale = (opts: { expiresInSeconds?: number } = {}) =>
    seedUploadSession(h, reporterId, { state: 'in_progress', updatedSecondsAgo: h.config.UPLOAD_RECONCILE_STALE_SECONDS + 60, ...opts });
  const session = async (id: string) => (await h.pool.query(`SELECT state, failure_reason, storage_key, updated_at FROM upload_sessions WHERE id = $1`, [id])).rows[0];
  const events = async (id: string) => (await h.pool.query(`SELECT type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [id])).rows.map((r) => r.type);
  // قاعدة الاختبار مشتركة: جلسات قديمة من ملفات أخرى قد تسبق جلسات هذا الملف، فتُفرغ الدفعات حتى لا يبقى راكد
  const drain = async () => {
    do await reconciler.reconcileBatch(500);
    while ((await stillStale()) > 0);
  };
  const stillStale = async () =>
    (
      await h.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM upload_sessions WHERE state = 'in_progress' AND updated_at < now() - make_interval(secs => $1)`,
        [h.config.UPLOAD_RECONCILE_STALE_SECONDS],
      )
    ).rows[0]!.n;

  it('a stale session whose object is in storage is received exactly as post-finish would', async () => {
    const s = await stale();
    storage.keys.add(`tus/${s.id}`);
    await drain();
    expect(await session(s.id)).toMatchObject({ state: 'completed', storage_key: `tus/${s.id}` });
    expect(await events(s.id)).toEqual(['upload.original_received']);
    const { rows } = await h.pool.query(`SELECT technical_state FROM materials WHERE id = $1`, [s.materialId]);
    expect(rows[0].technical_state).toBe('original_received');
    // post-finish المتأخر بعدها بلا أثر جديد
    await request(h.app.getHttpServer())
      .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
      .send({
        Type: 'post-finish',
        Event: {
          Upload: { ID: s.id, Size: 1000, Offset: 1000, MetaData: { upload_session_id: s.id }, Storage: { Type: 's3store', Bucket: 'uploads', Key: `tus/${s.id}` } },
          HTTPRequest: { Method: 'PATCH', URI: `/files/${s.id}`, Header: {} },
        },
      })
      .expect(200);
    expect(await events(s.id)).toEqual(['upload.original_received']);
  });

  it('a stale expired session without an object fails as expired; an unexpired one waits for another round', async () => {
    const expired = await stale({ expiresInSeconds: -10 });
    const ongoing = await stale();
    await drain();
    expect(await session(expired.id)).toMatchObject({ state: 'failed', failure_reason: 'expired' });
    expect(await events(expired.id)).toEqual(['upload.failed']);
    const row = await session(ongoing.id);
    expect(row.state).toBe('in_progress');
    expect(Date.now() - new Date(row.updated_at).getTime()).toBeLessThan(60_000);
    expect(await events(ongoing.id)).toEqual([]);
  });

  it('leaves fresh in_progress sessions alone', async () => {
    const fresh = await seedUploadSession(h, reporterId, { state: 'in_progress' });
    storage.keys.add(`tus/${fresh.id}`);
    await drain();
    expect((await session(fresh.id)).state).toBe('in_progress');
  });

  it('racing a late post-finish never receives the upload twice', async () => {
    const postFinish = (id: string) =>
      request(h.app.getHttpServer())
        .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
        .send({
          Type: 'post-finish',
          Event: {
            Upload: { ID: id, Size: 1000, Offset: 1000, MetaData: { upload_session_id: id }, Storage: { Type: 's3store', Bucket: 'uploads', Key: `tus/${id}` } },
            HTTPRequest: { Method: 'PATCH', URI: `/files/${id}`, Header: {} },
          },
        });
    for (let round = 0; round < 8; round++) {
      const s = await stale();
      storage.keys.add(`tus/${s.id}`);
      // الترتيب يتبدل بين الجولات: مرة تبدأ المكنسة ومرة الخطّاف
      const [first, second] = round % 2 ? [() => postFinish(s.id).expect(200), () => reconciler.reconcileBatch(500)] : [() => reconciler.reconcileBatch(500), () => postFinish(s.id).expect(200)];
      await Promise.all([first(), second()]);
      expect((await session(s.id)).state).toBe('completed');
      expect(await events(s.id)).toEqual(['upload.original_received']);
      const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM material_transitions WHERE material_id = $1 AND to_state = 'original_received'`, [s.materialId]);
      expect(rows[0].n).toBe(1);
    }
  });

  it('a storage outage changes nothing and does not throw', async () => {
    const s = await stale();
    storage.keys.add(`tus/${s.id}`);
    storage.failing = true;
    await expect(reconciler.reconcileBatch(500)).resolves.toEqual({ received: 0, expired: 0, pending: 0 });
    expect((await session(s.id)).state).toBe('in_progress');
    storage.failing = false;
    await drain();
    expect((await session(s.id)).state).toBe('completed');
  });
});
