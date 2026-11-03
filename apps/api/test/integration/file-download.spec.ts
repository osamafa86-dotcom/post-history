import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { OBJECT_STORAGE, S3ObjectStorage } from '../../src/verification/object-storage';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

describe('GET /materials/{id}/files/{file_id}/download-url (v0.1)', () => {
  // التوقيع محلي بلا شبكة؛ المضيف العام هو ما يصل إليه العميل
  const storage = new S3ObjectStorage({
    endpoint: 'http://minio.internal:9000',
    publicEndpoint: 'https://media.example.test',
    region: 'us-east-1',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'test-secret-key',
  });
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ overrides: [[OBJECT_STORAGE, storage]] });
  });
  afterAll(() => h.close());

  it('signs a short link for a verified derivative only; originals, unverified files and other scopes are 404', async () => {
    const reporter = await loginAs(h, [{ role: 'reporter' }]);
    const other = await loginAs(h, [{ role: 'reporter' }]);
    const { materialId } = await seedUploadSession(h, reporter.id);
    const file = async (kind: string, state: string, derivedFrom: string | null, key: string) =>
      (
        await h.pool.query<{ id: string }>(
          `INSERT INTO material_files (material_id, kind, state, derived_from_id, storage_key, size_bytes, sha256, mime_type, verified_at, proxy_mode)
           VALUES ($1, $2, $3, $4, $5, 10, $6, 'video/mp4', CASE WHEN $3 = 'verified' THEN now() END, CASE WHEN $2 = 'proxy' THEN 'normal' END) RETURNING id`,
          [materialId, kind, state, derivedFrom, key, state === 'verified' ? Buffer.alloc(32, 1) : null],
        )
      ).rows[0]!.id;
    const original = await file('original', 'verified', null, `tus/${randomUUID()}`);
    const proxyKey = `derived/${materialId}/${original}/proxy.mp4`;
    const proxy = await file('proxy', 'verified', original, proxyKey);
    const pending = await file('thumbnail', 'received', original, `derived/${materialId}/${original}/thumb.jpg`);

    const get = (token: string, fileId: string, mid = materialId) =>
      request(h.app.getHttpServer()).get(`/v1/materials/${mid}/files/${fileId}/download-url`).set('Authorization', `Bearer ${token}`);
    const res = await get(reporter.token, proxy).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const valid = schemaValidator('FileDownloadUrl');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    const url = new URL(res.body.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://media.example.test/${h.config.S3_BUCKET_MEDIA}/${proxyKey}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    const ttl = (Date.parse(res.body.expires_at) - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);

    for (const id of [original, pending, randomUUID(), 'nope']) await get(reporter.token, id).expect(404);
    await get(other.token, proxy).expect(404);
    const { rows } = await h.pool.query(`SELECT details FROM audit_log WHERE action = 'material_file.download_url_issued' AND target_id = $1`, [proxy]);
    expect(rows).toEqual([{ details: { material_id: materialId, file_id: proxy } }]);
  });

  // ADR 0115: نسخة الهاتف الخفيفة (حاوية الرفع، بلا مصدر على الخادم) لم تُنقَّ؛ الطاقم يرى ما صنعه العامل من الأصل وحده
  it('serves the phone-made proxy to the material owner only; staff see and fetch the server-made proxy alone', async () => {
    const office = (await h.pool.query<{ id: string }>(`INSERT INTO offices (name_ar, name_en) VALUES ('م', 'o') RETURNING id`)).rows[0]!.id;
    const reporter = await loginAs(h, [{ role: 'reporter' }], { officeId: office });
    const supervisor = await loginAs(h, [{ role: 'supervisor', scopeKind: 'office', scopeId: office }]);
    const { materialId } = await seedUploadSession(h, reporter.id);
    await h.pool.query(`UPDATE materials SET office_id = $2 WHERE id = $1`, [materialId, office]);
    const insert = async (kind: string, derivedFrom: string | null, key: string) =>
      (
        await h.pool.query<{ id: string }>(
          `INSERT INTO material_files (material_id, kind, state, derived_from_id, storage_key, size_bytes, sha256, mime_type, verified_at, proxy_mode)
           VALUES ($1, $2, 'verified', $3, $4, 10, $5, 'video/mp4', now(), CASE WHEN $2 = 'proxy' THEN 'normal' END) RETURNING id`,
          [materialId, kind, derivedFrom, key, Buffer.alloc(32, 2)],
        )
      ).rows[0]!.id;
    const phone = await insert('proxy', null, `tus/${randomUUID()}`);
    const original = await insert('original', null, `tus/${randomUUID()}`);
    const server = await insert('proxy', original, `derived/${materialId}/${original}/proxy-480p.mp4`);
    const url = (token: string, fileId: string) =>
      request(h.app.getHttpServer()).get(`/v1/materials/${materialId}/files/${fileId}/download-url`).set('Authorization', `Bearer ${token}`);
    const files = async (token: string) =>
      ((await request(h.app.getHttpServer()).get(`/v1/materials/${materialId}`).set('Authorization', `Bearer ${token}`).expect(200)).body.files as Array<{ id: string; kind: string }>)
        .filter((f) => f.kind === 'proxy')
        .map((f) => f.id)
        .sort();

    expect(await files(reporter.token)).toEqual([phone, server].sort());
    expect(await files(supervisor.token)).toEqual([server]);
    await url(reporter.token, phone).expect(200);
    expect((await url(supervisor.token, phone).expect(404)).body.code).toBe('not_found');
    const staff = await url(supervisor.token, server).expect(200);
    expect(new URL(staff.body.url).pathname).toContain(`/${h.config.S3_BUCKET_MEDIA}/`);
  });
});
