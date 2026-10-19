import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createHarness, type Harness, seedUploadSession, seedUser } from './harness';

describe('tusd hooks (/internal/tusd-hooks/{hook_token}, SEC-06)', () => {
  let h: Harness;
  let reporterId: string;
  beforeAll(async () => {
    h = await createHarness();
    reporterId = (await seedUser(h)).id;
  });
  afterAll(() => h.close());

  const hook = (body: object, token = h.config.TUSD_HOOK_SECRET) =>
    request(h.app.getHttpServer()).post(`/internal/tusd-hooks/${token}`).send(body);

  const preCreate = (sessionId: string, opts: { token?: string; size?: number } = {}) => ({
    Type: 'pre-create',
    Event: {
      Upload: { ID: '', Size: opts.size ?? 1000, MetaData: { upload_session_id: sessionId } },
      HTTPRequest: { Method: 'POST', URI: '/files/', Header: opts.token ? { Authorization: [`Bearer ${opts.token}`] } : {} },
    },
  });

  const postFinish = (sessionId: string, key: string, bucket = 'uploads') => ({
    Type: 'post-finish',
    Event: {
      Upload: {
        ID: `${sessionId}+multipart-id`,
        Size: 1000,
        Offset: 1000,
        MetaData: { upload_session_id: sessionId },
        Storage: { Type: 's3store', Bucket: bucket, Key: key },
      },
      HTTPRequest: { Method: 'PATCH', URI: `/files/${sessionId}`, Header: {} },
    },
  });

  const session = async (id: string) =>
    (await h.pool.query(`SELECT * FROM upload_sessions WHERE id = $1`, [id])).rows[0];
  const events = async (id: string) =>
    (await h.pool.query(`SELECT type, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [id])).rows;

  it('rejects a wrong hook token with 401 and no side effect', async () => {
    const s = await seedUploadSession(h, reporterId);
    const res = await hook(postFinish(s.id, `tus/${s.id}`), 'x'.repeat(48)).expect(401);
    expect(res.body.code).toBe('unauthorized');
    expect((await session(s.id)).state).toBe('created');
    expect(await events(s.id)).toEqual([]);
  });

  it('pre-create accepts a valid upload token and pins the object ID to the session', async () => {
    const s = await seedUploadSession(h, reporterId);
    const res = await hook(preCreate(s.id, { token: s.uploadToken })).expect(200);
    expect(res.body).toEqual({ RejectUpload: false, ChangeFileInfo: { ID: s.id } });
    const row = await session(s.id);
    expect(row.state).toBe('in_progress');
    expect(row.storage_key).toBe(`tus/${s.id}`);
  });

  it.each([
    ['missing token', async (s: { uploadToken: string }) => ({ token: undefined as string | undefined, size: 1000, s })],
    ['wrong token', async (s: { uploadToken: string }) => ({ token: 'wrong-token', size: 1000, s })],
    ['size mismatch', async (s: { uploadToken: string }) => ({ token: s.uploadToken, size: 999, s })],
  ])('pre-create rejects: %s', async (_name, build) => {
    const s = await seedUploadSession(h, reporterId);
    const { token, size } = await build(s);
    const res = await hook(preCreate(s.id, { token, size })).expect(200);
    expect(res.body.RejectUpload).toBe(true);
    expect((await session(s.id)).state).toBe('created');
  });

  it('pre-create rejects expired, finished, revoked or unknown sessions', async () => {
    const expired = await seedUploadSession(h, reporterId, { expiresInSeconds: -1 });
    const finished = await seedUploadSession(h, reporterId, { state: 'completed' });
    const revoked = await seedUploadSession(h, reporterId);
    await h.pool.query(`UPDATE upload_sessions SET upload_token_hash = NULL WHERE id = $1`, [revoked.id]);
    for (const s of [expired, finished, revoked]) {
      expect((await hook(preCreate(s.id, { token: s.uploadToken })).expect(200)).body.RejectUpload).toBe(true);
    }
    expect((await hook(preCreate(randomUUID(), { token: 'x' })).expect(200)).body.RejectUpload).toBe(true);
  });

  it('post-finish completes the session and writes one outbox event, idempotently', async () => {
    const s = await seedUploadSession(h, reporterId);
    await hook(preCreate(s.id, { token: s.uploadToken })).expect(200);
    const first = await hook(postFinish(s.id, `tus/${s.id}`)).expect(200);
    const again = await hook(postFinish(s.id, `tus/${s.id}`)).expect(200);
    expect(again.body).toEqual(first.body);
    const row = await session(s.id);
    expect(row.state).toBe('completed');
    expect(row.tus_upload_id).toBe(`${s.id}+multipart-id`);
    expect(await events(s.id)).toEqual([
      { type: 'upload.original_received', payload: { material_id: s.materialId, upload_session_id: s.id, kind: 'original' } },
    ]);
  });

  it('post-finish with a storage key that does not match the session fails it with storage_error', async () => {
    const s = await seedUploadSession(h, reporterId, { kind: 'proxy' });
    await hook(preCreate(s.id, { token: s.uploadToken })).expect(200);
    await hook(postFinish(s.id, 'tus/someone-elses-object')).expect(200);
    const row = await session(s.id);
    expect(row.state).toBe('failed');
    expect(row.failure_reason).toBe('storage_error');
    expect(await events(s.id)).toEqual([
      {
        type: 'upload.failed',
        payload: { material_id: s.materialId, upload_session_id: s.id, kind: 'proxy', failure_reason: 'storage_error' },
      },
    ]);
  });

  it('post-finish in a different bucket is a storage_error too', async () => {
    const s = await seedUploadSession(h, reporterId);
    await hook(preCreate(s.id, { token: s.uploadToken })).expect(200);
    await hook(postFinish(s.id, `tus/${s.id}`, 'media')).expect(200);
    expect((await session(s.id)).failure_reason).toBe('storage_error');
  });

  it('post-finish for an unknown session is 404; a malformed body is 422', async () => {
    const id = randomUUID();
    await hook(postFinish(id, `tus/${id}`)).expect(404);
    await hook({ Type: 'post-finish', Event: {} }).expect(422);
  });

  it('ignores hook types it does not handle', async () => {
    const s = await seedUploadSession(h, reporterId);
    const body = { ...postFinish(s.id, `tus/${s.id}`), Type: 'post-receive' };
    expect((await hook(body).expect(200)).body).toEqual({ RejectUpload: false });
    expect((await session(s.id)).state).toBe('created');
  });

  it('is not reachable under /v1', async () => {
    await request(h.app.getHttpServer()).post(`/v1/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`).send({}).expect(404);
  });
});
