import { randomBytes, randomUUID } from 'node:crypto';
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

  it('the upload token opens one upload only: a second pre-create on an in_progress session is rejected', async () => {
    const s = await seedUploadSession(h, reporterId);
    await hook(preCreate(s.id, { token: s.uploadToken })).expect(200);
    const again = await hook(preCreate(s.id, { token: s.uploadToken })).expect(200);
    expect(again.body.RejectUpload).toBe(true);
    expect((await session(s.id)).state).toBe('in_progress');
  });

  it('post-create is ignored while TUSD_POST_CREATE_HOOK is off', async () => {
    const s = await seedUploadSession(h, reporterId);
    expect((await hook({ ...preCreate(s.id), Type: 'post-create' }).expect(200)).body).toEqual({ RejectUpload: false });
    expect((await session(s.id)).state).toBe('created');
  });

  describe('with TUSD_POST_CREATE_HOOK=true', () => {
    let hp: Harness;
    beforeAll(async () => {
      hp = await createHarness({ env: { TUSD_POST_CREATE_HOOK: 'true' } });
    });
    afterAll(() => hp.close());
    const hookP = (body: object) => request(hp.app.getHttpServer()).post(`/internal/tusd-hooks/${hp.config.TUSD_HOOK_SECRET}`).send(body);

    it('pre-create reserves the session; a failed tusd create retries with the same token once the reservation lapses', async () => {
      const s = await seedUploadSession(hp, reporterId);
      expect((await hookP(preCreate(s.id, { token: s.uploadToken })).expect(200)).body).toEqual({ RejectUpload: false, ChangeFileInfo: { ID: s.id } });
      const reserved = await session(s.id);
      expect(reserved).toMatchObject({ state: 'created', storage_key: `tus/${s.id}` });
      const seconds = (new Date(reserved.hook_reserved_until).getTime() - Date.now()) / 1000;
      expect(seconds).toBeGreaterThan(50);
      expect(seconds).toBeLessThanOrEqual(61);
      // tusd لا يرفض المعرّف المكرّر: pre-create ثانٍ والحجز حي يُرفض
      expect((await hookP(preCreate(s.id, { token: s.uploadToken })).expect(200)).body.RejectUpload).toBe(true);
      // لم يصل post-create (فشل الإنشاء لدى tusd) وانقضى الحجز: يُعاد بالرمز نفسه
      await hp.pool.query(`UPDATE upload_sessions SET hook_reserved_until = now() - interval '1 second' WHERE id = $1`, [s.id]);
      expect((await hookP(preCreate(s.id, { token: s.uploadToken })).expect(200)).body.RejectUpload).toBe(false);
      await hookP({ ...preCreate(s.id), Type: 'post-create' }).expect(200);
      expect(await session(s.id)).toMatchObject({ state: 'in_progress', hook_reserved_until: null });
      expect((await hookP(preCreate(s.id, { token: s.uploadToken })).expect(200)).body.RejectUpload).toBe(true);
      // tusd يعيد post-create أحيانًا: بلا أثر، ثم post-finish يكمل كالمعتاد
      await hookP({ ...preCreate(s.id), Type: 'post-create' }).expect(200);
      await hookP(postFinish(s.id, `tus/${s.id}`)).expect(200);
      expect((await session(s.id)).state).toBe('completed');
      await hookP({ ...preCreate(s.id), Type: 'post-create' }).expect(200);
      expect((await session(s.id)).state).toBe('completed');
    });

    it('two concurrent pre-creates for one session: exactly one is accepted', async () => {
      for (let round = 0; round < 5; round++) {
        const s = await seedUploadSession(hp, reporterId);
        const results = await Promise.all([0, 1, 2].map(() => hookP(preCreate(s.id, { token: s.uploadToken })).expect(200)));
        expect(results.filter((r) => r.body.RejectUpload === false)).toHaveLength(1);
      }
    });

    it('post-finish without a post-create clears the reservation with the state', async () => {
      const s = await seedUploadSession(hp, reporterId);
      await hookP(preCreate(s.id, { token: s.uploadToken })).expect(200);
      await hookP(postFinish(s.id, `tus/${s.id}`)).expect(200);
      expect(await session(s.id)).toMatchObject({ state: 'completed', hook_reserved_until: null });
    });
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

  it('pre-create rejects an expired upload token even while the session is still open (v0.1 column)', async () => {
    const s = await seedUploadSession(h, reporterId, { expiresInSeconds: 3600, tokenExpiresInSeconds: -1 });
    expect((await hook(preCreate(s.id, { token: s.uploadToken })).expect(200)).body.RejectUpload).toBe(true);
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
    // المسار الفني للمادة يتقدم بانتقال يكتبه الخادم (actor فارغ) مرة واحدة رغم التكرار
    const { rows: m } = await h.pool.query(`SELECT technical_state FROM materials WHERE id = $1`, [s.materialId]);
    expect(m[0].technical_state).toBe('original_received');
    const { rows: t } = await h.pool.query(`SELECT from_state, to_state, actor_id FROM material_transitions WHERE material_id = $1`, [s.materialId]);
    expect(t).toEqual([{ from_state: 'pending', to_state: 'original_received', actor_id: null }]);
    expect((await events(s.materialId)).map((e) => e.type)).toEqual(['material.technical_transition']);
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

  it('pre-create without upload_session_id metadata is rejected in the tusd format (400 to the client), not 422', async () => {
    for (const MetaData of [{}, { upload_session_id: 'not-a-uuid' }]) {
      const res = await hook({ Type: 'pre-create', Event: { Upload: { Size: 10, MetaData }, HTTPRequest: { Header: {} } } }).expect(200);
      expect(res.body).toEqual({ RejectUpload: true, HTTPResponse: { StatusCode: 400, Body: 'upload_session_id metadata is required' } });
    }
    // ما ليس بصيغة tusd أصلًا (بلا Event.Upload) يبقى 422 كما في العقد
    await hook({ Type: 'pre-create' }).expect(422);
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

  it('/internal/* answers 404 to socket addresses outside INTERNAL_ALLOWED_CIDRS, even with X-Forwarded-For', async () => {
    const outside = await createHarness({ env: { INTERNAL_ALLOWED_CIDRS: '10.0.0.0/8', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' } });
    try {
      const res = await request(outside.app.getHttpServer())
        .post(`/internal/tusd-hooks/${outside.config.TUSD_HOOK_SECRET}`)
        .set('X-Forwarded-For', '10.1.2.3')
        .send({})
        .expect(404);
      expect(res.body.code).toBe('not_found');
    } finally {
      await outside.close();
    }
  });

  it('accepts the previous hook secret only until its transition deadline', async () => {
    const previous = randomBytes(24).toString('hex');
    for (const [until, status] of [
      [new Date(Date.now() + 60_000).toISOString(), 200],
      [new Date(Date.now() - 1_000).toISOString(), 401],
    ] as const) {
      const rot = await createHarness({ env: { TUSD_HOOK_SECRET_PREVIOUS: previous, TUSD_HOOK_SECRET_PREVIOUS_UNTIL: until } });
      try {
        const post = (token: string) => request(rot.app.getHttpServer()).post(`/internal/tusd-hooks/${token}`).send({ Type: 'post-receive', Event: {} });
        await post(rot.config.TUSD_HOOK_SECRET).expect((r) => expect(r.status).not.toBe(401));
        await post(previous).expect((r) => expect(r.status === 401 ? 401 : 200).toBe(status));
        await post('x'.repeat(48)).expect(401);
      } finally {
        await rot.close();
      }
    }
  });

  it('is not reachable under /v1', async () => {
    await request(h.app.getHttpServer()).post(`/v1/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`).send({}).expect(404);
  });
});
