import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { createHarness, ensureForm, type Harness, loginAs } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

/** حجم الملف وبصمته الصحيحة كما يرسلهما التطبيق (ملف اصطناعي بالحجم المعلن). */
const file = (size: number) => ({ size_bytes: size, client_sha256: createHash('sha256').update(Buffer.alloc(size, 7)).digest('hex') });

describe('upload sessions (/v1/uploads)', () => {
  let h: Harness;
  let office: string;
  let reporter: Actor;
  let other: Actor;
  let supervisor: Actor;
  beforeAll(async () => {
    h = await createHarness();
    await ensureForm(h);
    office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    other = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  const write = (a: Actor, url: string, body?: object, key = randomUUID()) =>
    http().post(url).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body);
  const material = async (a: Actor = reporter) =>
    (
      await write(a, '/v1/materials', {
        title: 'Footage for upload',
        material_types: ['report'],
        governorate: 'gaza',
        city: 'gaza',
        priority: 'normal',
        sensitivity: { minors: false, injured: false, graphic: false },
        display_name: { mode: 'network' },
        form_version: 1,
        dynamic_fields: {},
      }).expect(201)
    ).body.id as string;
  const preCreate = (sessionId: string, token: string, size: number) =>
    http()
      .post(`/internal/tusd-hooks/${h.config.TUSD_HOOK_SECRET}`)
      .send({
        Type: 'pre-create',
        Event: { Upload: { Size: size, MetaData: { upload_session_id: sessionId } }, HTTPRequest: { Header: { Authorization: [`Bearer ${token}`] } } },
      })
      .expect(200);

  it('creates a session: token shown once and stored hashed, contract shape, event, and the hook accepts it', async () => {
    const materialId = await material();
    const res = await write(reporter, '/v1/uploads', { material_id: materialId, kind: 'original', ...file(2048), filename: 'IMG_0001.MOV' }).expect(201);
    const valid = schemaValidator('UploadSessionCreated');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    expect(res.body).toMatchObject({
      material_id: materialId,
      state: 'created',
      tus_metadata: { upload_session_id: res.body.id, filename: 'IMG_0001.MOV' },
      part_size_bytes: h.config.TUSD_PART_SIZE_BYTES,
      checksum_algorithm: 'sha256',
    });
    const { rows } = await h.pool.query(`SELECT upload_token_hash, upload_token_expires_at FROM upload_sessions WHERE id = $1`, [res.body.id]);
    expect(rows[0].upload_token_hash.equals(createHash('sha256').update(res.body.upload_token).digest())).toBe(true);
    // الرمز ينتهي قبل الجلسة (v0.1): عمر الرمز مستقل ولا يتجاوزها
    expect(new Date(res.body.upload_token_expires_at).getTime()).toBe(new Date(rows[0].upload_token_expires_at).getTime());
    const tokenTtl = (Date.parse(res.body.upload_token_expires_at) - Date.now()) / 1000;
    expect(tokenTtl).toBeGreaterThan(h.config.UPLOAD_TOKEN_TTL_SECONDS - 60);
    expect(tokenTtl).toBeLessThanOrEqual(h.config.UPLOAD_TOKEN_TTL_SECONDS);
    expect(Date.parse(res.body.upload_token_expires_at)).toBeLessThan(Date.parse(res.body.expires_at));
    const { rows: ev } = await h.pool.query(`SELECT type FROM outbox_events WHERE aggregate_id = $1`, [res.body.id]);
    expect(ev.map((e) => e.type)).toEqual(['upload.started']);
    expect((await preCreate(res.body.id, res.body.upload_token, 2048)).body.RejectUpload).toBe(false);
  });

  it('a replay with the same key mints a new token for the same session and never stores the token', async () => {
    const materialId = await material();
    const key = randomUUID();
    const body = { material_id: materialId, kind: 'proxy', proxy_mode: 'urgent', ...file(4096), filename: 'proxy.mp4' };
    const first = await write(reporter, '/v1/uploads', body, key).expect(201);
    const second = await write(reporter, '/v1/uploads', body, key).expect(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.upload_token).not.toBe(first.body.upload_token);
    const { rows } = await h.pool.query(`SELECT response_body FROM idempotency_keys WHERE key = $1`, [key]);
    expect(rows[0].response_body).not.toHaveProperty('upload_token');
    expect(JSON.stringify(rows[0].response_body)).not.toContain(first.body.upload_token);
    expect((await preCreate(first.body.id, first.body.upload_token, 4096)).body.RejectUpload).toBe(true);
    expect((await preCreate(first.body.id, second.body.upload_token, 4096)).body.RejectUpload).toBe(false);
    // بعد بدء الرفع لا يُصدر رمز جديد: الرمز لا يُقبل إلا في created
    expect((await write(reporter, '/v1/uploads', body, key).expect(409)).body.code).toBe('upload_state_conflict');
  });

  it("refuses other people's materials (404), other roles (403), and proxy_mode on an original (422)", async () => {
    const materialId = await material();
    await write(other, '/v1/uploads', { material_id: materialId, kind: 'original', ...file(1), filename: 'a' }).expect(404);
    // الطاقم ينشئ جلسات لموادّه هو (#88)؛ مادة المراسل ليست له، ومن لا يرفع أصلًا 403
    await write(supervisor, '/v1/uploads', { material_id: materialId, kind: 'original', ...file(1), filename: 'a' }).expect(404);
    const rights = await loginAs(h, [{ role: 'rights_officer' }]);
    await write(rights, '/v1/uploads', { material_id: materialId, kind: 'original', ...file(1), filename: 'a' }).expect(403);
    await write(reporter, '/v1/uploads', { material_id: materialId, kind: 'original', proxy_mode: 'normal', ...file(1), filename: 'a' }).expect(422);
    await write(reporter, '/v1/uploads', { material_id: randomUUID(), kind: 'original', ...file(1), filename: 'a' }).expect(404);
  });

  it('staff upload camera files from the web (#88): they own what they create, originals only, and see it whatever their role scope', async () => {
    const producer = await loginAs(h, [{ role: 'producer' }], { officeId: office });
    const chief = await loginAs(h, [{ role: 'editor_in_chief' }]);
    for (const staff of [supervisor, producer, chief]) {
      const id = await material(staff);
      const m = (await http().get(`/v1/materials/${id}`).set('Authorization', `Bearer ${staff.token}`).expect(200)).body;
      expect(m.reporter_id).toBe(staff.id);
      const s = (await write(staff, '/v1/uploads', { material_id: id, kind: 'original', ...file(10), filename: 'card.mxf' }).expect(201)).body;
      await http().get(`/v1/uploads/${s.id}`).set('Authorization', `Bearer ${staff.token}`).expect(200);
      // النسخة الخفيفة يولّدها عامل الوسائط، لا الطاقم
      await write(staff, '/v1/uploads', { material_id: id, kind: 'proxy', proxy_mode: 'normal', ...file(10), filename: 'p.mp4' }).expect(422);
      // مادة الطاقم ليست لغيره: مراسل آخر لا يرفع لها
      await write(reporter, '/v1/uploads', { material_id: id, kind: 'original', ...file(10), filename: 'x' }).expect(404);
    }
    // منتج آخر لا يرى مادة منتج في الوارد (نطاق المنتج: ما قُبل للإنتاج)
    const otherProducer = await loginAs(h, [{ role: 'producer' }]);
    const mine = await material(producer);
    await http().get(`/v1/materials/${mine}`).set('Authorization', `Bearer ${otherProducer.token}`).expect(404);
    // من لا يرفع لا ينشئ مادة
    const rights = await loginAs(h, [{ role: 'rights_officer' }]);
    await write(rights, '/v1/materials', { title: 'x' }).expect(403);
  });

  it('GET returns the session without the token to the owner and to a supervisor in scope, 404 to others', async () => {
    const materialId = await material();
    const created = (await write(reporter, '/v1/uploads', { material_id: materialId, kind: 'original', ...file(10), filename: 'f.mov' }).expect(201)).body;
    const mine = await http().get(`/v1/uploads/${created.id}`).set('Authorization', `Bearer ${reporter.token}`).expect(200);
    const valid = schemaValidator('UploadSession');
    expect(valid(mine.body) ? [] : valid.errors).toEqual([]);
    expect(mine.body).not.toHaveProperty('upload_token');
    expect(mine.body.receipt_number).toBeNull();
    await http().get(`/v1/uploads/${created.id}`).set('Authorization', `Bearer ${supervisor.token}`).expect(200);
    await http().get(`/v1/uploads/${created.id}`).set('Authorization', `Bearer ${other.token}`).expect(404);
  });

  it('complete is for the direct path only: 409 on a tusd session', async () => {
    const materialId = await material();
    const created = (await write(reporter, '/v1/uploads', { material_id: materialId, kind: 'original', ...file(10), filename: 'f' }).expect(201)).body;
    expect((await write(reporter, `/v1/uploads/${created.id}/complete`, {}).expect(409)).body.code).toBe('upload_state_conflict');
  });

  describe('UPLOAD_REQUIRE_CLIENT_SHA256', () => {
    const materialBody = {
      title: 'Checksum required',
      material_types: ['report'],
      governorate: 'gaza',
      city: 'gaza',
      priority: 'normal',
      sensitivity: { minors: false, injured: false, graphic: false },
      display_name: { mode: 'network' },
      form_version: 1,
      dynamic_fields: {},
    };

    // يرد التحقق نفسه (422) سواء رفضه العقد (حقل مطلوب، المسار '/') أو الخادم (المسار '/client_sha256')
    it('a session without client_sha256 is rejected with 422 validation_failed; with it, created', async () => {
      const strict = await createHarness({ env: { UPLOAD_REQUIRE_CLIENT_SHA256: 'true' } });
      try {
        const owner = await loginAs(strict, [{ role: 'reporter' }], { officeId: office });
        const post = (url: string, body: object) =>
          request(strict.app.getHttpServer()).post(url).set('Authorization', `Bearer ${owner.token}`).set('Idempotency-Key', randomUUID()).send(body);
        const materialId = (await post('/v1/materials', materialBody).expect(201)).body.id;
        const res = await post('/v1/uploads', { material_id: materialId, kind: 'original', size_bytes: 10, filename: 'f' }).expect(422);
        expect(res.body.code).toBe('validation_failed');
        await post('/v1/uploads', { material_id: materialId, kind: 'original', ...file(10), filename: 'f' }).expect(201);
      } finally {
        await strict.close();
      }
    });
  });

  describe('direct upload path', () => {
    let direct: Harness;
    let owner: Actor;
    beforeAll(async () => {
      direct = await createHarness({ env: { UPLOAD_PATH: 'direct' } });
      owner = await loginAs(direct, [{ role: 'reporter' }], { officeId: office });
    });
    afterAll(() => direct.close());

    const post = (url: string, body?: object) =>
      request(direct.app.getHttpServer()).post(url).set('Authorization', `Bearer ${owner.token}`).set('Idempotency-Key', randomUUID()).send(body);

    it('completes once (repeat is 202), derives the storage key, and rejects a mismatching reported checksum', async () => {
      const materialId = (
        await post('/v1/materials', {
          title: 'Direct upload material',
          material_types: ['report'],
          governorate: 'gaza',
          city: 'gaza',
          priority: 'normal',
          sensitivity: { minors: false, injured: false, graphic: false },
          display_name: { mode: 'network' },
          form_version: 1,
          dynamic_fields: {},
        }).expect(201)
      ).body.id;
      const sha = file(10).client_sha256;
      const s = (await post('/v1/uploads', { material_id: materialId, kind: 'original', ...file(10), filename: 'f' }).expect(201)).body;
      expect((await post(`/v1/uploads/${s.id}/complete`, { reported_sha256: 'b'.repeat(64) }).expect(422)).body.code).toBe('checksum_mismatch');
      await post(`/v1/uploads/${s.id}/complete`, { reported_sha256: sha }).expect(202);
      await post(`/v1/uploads/${s.id}/complete`, {}).expect(202);
      const { rows } = await direct.pool.query(`SELECT state, storage_key FROM upload_sessions WHERE id = $1`, [s.id]);
      expect(rows[0]).toEqual({ state: 'completed', storage_key: `tus/${s.id}` });
      const { rows: ev } = await direct.pool.query(`SELECT type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [s.id]);
      expect(ev.map((e) => e.type)).toEqual(['upload.started', 'upload.original_received']);
    });
  });
});
