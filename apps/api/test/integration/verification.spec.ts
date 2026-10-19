import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import request from 'supertest';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { VerificationWorker } from '../../src/verification/verification.worker';
import { createHarness, drainOutbox, type Harness, loginAs, seedUploadSession } from './harness';

/** تخزين بديل في الذاكرة يُقرأ على دفعات صغيرة ليُختبر الحساب التدفقي. */
class MemoryStorage implements ObjectStorage {
  objects = new Map<string, Buffer>();
  failing = false;
  /** تأخير كل قراءة رأس ليظهر التداخل، وعدّاد القراءات الجارية معًا وأقصاه. */
  delayMs = 0;
  heads = 0;
  inFlight = 0;
  maxInFlight = 0;
  async head(_bucket: string, key: string) {
    this.heads++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    } finally {
      this.inFlight--;
    }
    if (this.failing) throw new Error('storage down');
    const o = this.objects.get(key);
    return o ? { size: o.length } : null;
  }
  async read(_bucket: string, key: string) {
    const o = this.objects.get(key)!;
    const chunks: Buffer[] = [];
    for (let i = 0; i < o.length; i += 1024) chunks.push(o.subarray(i, i + 1024));
    return Readable.from(chunks);
  }
}

describe('in-process upload verification (SHA-256 on the server)', () => {
  const storage = new MemoryStorage();
  let h: Harness;
  let worker: VerificationWorker;
  let reporter: Awaited<ReturnType<typeof loginAs>>;

  beforeAll(async () => {
    h = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
    worker = h.app.get(VerificationWorker);
    reporter = await loginAs(h, [{ role: 'reporter' }]);
    // جلسات مكتملة تركتها ملفات أخرى لا تدخل طابور هذا الاختبار
    await h.pool.query(`UPDATE upload_sessions SET state = 'failed', failure_reason = 'aborted' WHERE state = 'completed'`);
  });
  afterAll(() => h.close());
  beforeEach(() => {
    storage.failing = false;
    storage.delayMs = 0;
    storage.heads = 0;
    storage.maxInFlight = 0;
  });

  /** جلسة بلغت completed (كما يتركها post-finish) وكائنها في التخزين. */
  const completed = async (opts: { kind?: string; content?: Buffer; stored?: Buffer | null; clientSha?: Buffer } = {}) => {
    const content = opts.content ?? randomBytes(5000);
    const s = await seedUploadSession(h, reporter.id, { kind: opts.kind, size: content.length });
    const key = `tus/${s.id}`;
    await h.pool.query(
      `UPDATE upload_sessions SET state = 'completed', storage_key = $2, client_sha256 = $3 WHERE id = $1`,
      [s.id, key, opts.clientSha ?? null],
    );
    await h.pool.query(`UPDATE materials SET technical_state = 'original_received' WHERE id = $1`, [s.materialId]);
    if (opts.stored !== null) storage.objects.set(key, opts.stored ?? content);
    return { ...s, content };
  };
  const drainVerification = async () => {
    while (await worker.verifyNext());
  };
  const row = async (sql: string, id: string) => (await h.pool.query(sql, [id])).rows[0];
  const events = async (id: string) =>
    (await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [id])).rows;

  it('verifies an original: server-computed hash, file record, receipt number, technical verified, event', async () => {
    const s = await completed();
    await drainVerification();
    const session = await row(`SELECT state, file_id, bytes_received FROM upload_sessions WHERE id = $1`, s.id);
    expect(session).toMatchObject({ state: 'verified', bytes_received: String(s.content.length) });
    const file = await row(`SELECT * FROM material_files WHERE id = $1`, session.file_id);
    expect(file.sha256.equals(createHash('sha256').update(s.content).digest())).toBe(true);
    expect(file).toMatchObject({ state: 'verified', kind: 'original', storage_key: `tus/${s.id}` });
    expect(file.receipt_number).toMatch(/^R-\d{6}-\d{6}$/);
    expect((await row(`SELECT technical_state FROM materials WHERE id = $1`, s.materialId)).technical_state).toBe('verified');
    expect(await events(s.id)).toEqual([
      {
        type: 'upload.verified',
        payload: { material_id: s.materialId, upload_session_id: s.id, kind: 'original', file_id: file.id, receipt_number: file.receipt_number },
      },
    ]);

    // إشعار الاستلام برقم الإيصال يصل المراسل
    await drainOutbox(h);
    const inbox = await request(h.app.getHttpServer()).get('/v1/notifications').set('Authorization', `Bearer ${reporter.token}`).expect(200);
    expect(inbox.body.items.find((n: { material_id: string }) => n.material_id === s.materialId).title).toContain(file.receipt_number);
  });

  it('a matching client checksum passes; a different one fails with checksum_mismatch and fails the original', async () => {
    const content = randomBytes(3000);
    const ok = await completed({ content, clientSha: createHash('sha256').update(content).digest() });
    const bad = await completed({ clientSha: Buffer.alloc(32, 7) });
    await drainVerification();
    expect((await row(`SELECT state FROM upload_sessions WHERE id = $1`, ok.id)).state).toBe('verified');
    expect(await row(`SELECT state, failure_reason FROM upload_sessions WHERE id = $1`, bad.id)).toEqual({ state: 'failed', failure_reason: 'checksum_mismatch' });
    expect((await row(`SELECT technical_state FROM materials WHERE id = $1`, bad.materialId)).technical_state).toBe('failed');
    expect((await events(bad.id)).map((e) => e.type)).toEqual(['upload.failed']);
  });

  it('a missing object is storage_error; a size different from the session is invalid_file', async () => {
    const missing = await completed({ stored: null });
    const truncated = await completed({ content: randomBytes(4000), stored: randomBytes(3999) });
    await drainVerification();
    expect((await row(`SELECT failure_reason FROM upload_sessions WHERE id = $1`, missing.id)).failure_reason).toBe('storage_error');
    expect((await row(`SELECT failure_reason FROM upload_sessions WHERE id = $1`, truncated.id)).failure_reason).toBe('invalid_file');
  });

  it('a proxy is verified without a receipt and without touching the original track', async () => {
    const s = await completed({ kind: 'proxy' });
    await drainVerification();
    const session = await row(`SELECT file_id FROM upload_sessions WHERE id = $1`, s.id);
    expect((await row(`SELECT receipt_number FROM material_files WHERE id = $1`, session.file_id)).receipt_number).toBeNull();
    expect((await row(`SELECT technical_state FROM materials WHERE id = $1`, s.materialId)).technical_state).toBe('original_received');
    expect((await events(s.id))[0].payload).not.toHaveProperty('receipt_number');
  });

  it('a storage outage leaves the session completed for a later retry and ends the batch', async () => {
    const s = await completed();
    storage.failing = true;
    expect(await worker.verifyNext()).toBe(false);
    expect((await row(`SELECT state FROM upload_sessions WHERE id = $1`, s.id)).state).toBe('completed');
    storage.failing = false;
    await drainVerification();
    expect((await row(`SELECT state FROM upload_sessions WHERE id = $1`, s.id)).state).toBe('verified');
  });

  it('verifies up to VERIFY_CONCURRENCY files at once, each exactly once', async () => {
    const batch = await Promise.all(Array.from({ length: 6 }, () => completed()));
    storage.delayMs = 100;
    expect(h.config.VERIFY_CONCURRENCY).toBe(4);
    expect(await worker.drain()).toBe(6);
    expect(storage.maxInFlight).toBe(4);
    expect(storage.heads).toBe(6);
    for (const s of batch) {
      expect((await row(`SELECT state FROM upload_sessions WHERE id = $1`, s.id)).state).toBe('verified');
      expect((await events(s.id)).map((e) => e.type)).toEqual(['upload.verified']);
    }
  });

  it('with concurrency 1 the files are read one after another', async () => {
    await Promise.all(Array.from({ length: 3 }, () => completed()));
    storage.delayMs = 20;
    expect(await worker.drain(1)).toBe(3);
    expect(storage.maxInFlight).toBe(1);
  });

  it('a storage outage costs at most one storage call per parallel loop', async () => {
    const batch = await Promise.all(Array.from({ length: 6 }, () => completed()));
    storage.failing = true;
    expect(await worker.drain(4)).toBe(0);
    expect(storage.heads).toBeLessThanOrEqual(4);
    for (const s of batch) expect((await row(`SELECT state FROM upload_sessions WHERE id = $1`, s.id)).state).toBe('completed');
    storage.failing = false;
    expect(await worker.drain()).toBe(6);
  });
});
