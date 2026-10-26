import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { DB, type Database } from '../../src/database/database.module';
import { uploadSessions } from '../../src/database/schema/schema';
import { OBJECT_STORAGE, type ObjectStorage } from '../../src/verification/object-storage';
import { recordVerification } from '../../src/verification/verification';
import { createHarness, type Harness, loginAs, seedUploadSession, seedUser } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

class SigningStorage implements ObjectStorage {
  async head() {
    return null;
  }
  async read() {
    return Readable.from([]);
  }
  presignGet(bucket: string, key: string, expiresSeconds: number) {
    return `https://storage.test/${bucket}/${key}?X-Amz-Expires=${expiresSeconds}`;
  }
}

// الكتالوج (v0.3، ADR 0025): الإدراجات المعروضة وحدها بقائمة CatalogItem البيضاء المغلقة، ومعاينة المشتري المائية
describe('catalog (/v1/catalog)', () => {
  const mediaToken = randomBytes(32).toString('base64url');
  let h: Harness;
  let rights: Actor;
  let admin: Actor;
  let finance: Actor;
  let producer: Actor;
  let reporterId: string;
  let single: string;
  let exclusive: string;
  let retired: string;
  beforeAll(async () => {
    h = await createHarness({ env: { MEDIA_WORKER_TOKEN: mediaToken, CATALOG_CREDIT: 'Test Network' }, overrides: [[OBJECT_STORAGE, new SigningStorage()]] });
    rights = await loginAs(h, [{ role: 'rights_officer' }]);
    admin = await loginAs(h, [{ role: 'system_admin' }]);
    finance = await loginAs(h, [{ role: 'finance' }]);
    producer = await loginAs(h, [{ role: 'producer' }]);
    reporterId = (await seedUser(h)).id;
    const tpl = async (type: string, price: number, extra: Record<string, unknown> = {}) =>
      (
        await write(admin, 'post', '/license-templates', {
          type,
          name: { ar: `ترخيص ${type}`, en: `License ${type}` },
          terms: { ar: 'ش', en: 'Terms' },
          usage_media: ['web'],
          territory: { kind: 'worldwide' },
          term_days: null,
          exclusivity_hours: null,
          deliverables: ['original'],
          attribution: { ar: 'ن', en: 'A' },
          prohibitions: [],
          base_price: { amount_minor: price, currency: 'USD' },
          enabled: true,
          ...extra,
        }).expect(201)
      ).body.id as string;
    single = await tpl('editorial_single', 5000);
    exclusive = await tpl('exclusive_temporary', 90000, { term_days: 30, exclusivity_hours: 48 });
    retired = await tpl('editorial_term', 7000, { term_days: 90 });
  });
  afterAll(() => h.close());

  const http = () => request(h.app.getHttpServer());
  function write(a: Actor, method: 'post' | 'put', url: string, body: object) {
    return http()[method](`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', randomUUID()).send(body);
  }
  const get = (a: Actor, url: string) => http().get(`/v1${url}`).set('Authorization', `Bearer ${a.token}`);
  const tag = randomUUID().slice(0, 8);

  /** مادة قابلة للبيع بأصل متحقق ودقة ومدة، ثم إدراجها بالحالة المطلوبة. */
  const listed = async (o: { state?: string; title?: string; governorate?: string; height?: number; durationMs?: number; shotAt?: string; offers?: object[] } = {}) => {
    const materialId = (await seedUploadSession(h, reporterId)).materialId;
    await h.pool.query(
      `UPDATE materials SET rights_state = 'sellable', governorate = $2, city = 'secret-city', shot_at = $3, display_name_mode = 'pseudonym', display_name_pseudonym = 'Hidden Alias' WHERE id = $1`,
      [materialId, o.governorate ?? 'gaza', o.shotAt ?? '2026-10-20T21:30:00Z'],
    );
    const { rows } = await h.pool.query<{ id: string }>(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, duration_ms, width, height)
       VALUES ($1, 'original', 'received', 5000, $2, $3, $4, $5, $6) RETURNING id`,
      [materialId, randomBytes(32), `tus/${randomUUID()}`, o.durationMs ?? 60000, Math.round(((o.height ?? 1080) * 16) / 9), o.height ?? 1080],
    );
    await h.pool.query(`UPDATE material_files SET state = 'verified', verified_at = now() WHERE id = $1`, [rows[0]!.id]);
    const res = await write(rights, 'post', `/materials/${materialId}/listing`, {
      title: { ar: `عنوان ${tag} ${o.title ?? ''}`, en: `Title ${tag} ${o.title ?? ''}` },
      description: { ar: 'وصف', en: 'Description' },
      shot_list: [{ start_ms: 0, label: { ar: 'لقطة', en: 'Shot' } }],
      offers: o.offers ?? [{ license_template_id: single, price_override: { amount_minor: 4200, currency: 'ILS' } }],
      state: o.state ?? 'listed',
    }).expect(201);
    return { materialId, listingId: res.body.id as string, originalId: rows[0]!.id };
  };
  const mine = (body: { items: Array<{ listing_id: string }> }) => body.items.map((i) => i.listing_id);

  it('shows listed items only, in the closed whitelist: no coordinates, city, hour, reporter, material id, alias or dynamic fields; network credit; current offer prices', async () => {
    const a = await listed({ height: 2160, durationMs: 125000, offers: [{ license_template_id: single, price_override: { amount_minor: 4200, currency: 'ILS' } }, { license_template_id: retired }] });
    const draft = await listed({ state: 'draft' });
    const item = (await get(finance, `/catalog/${a.listingId}`).expect(200)).body;
    const valid = schemaValidator('CatalogItem');
    expect(valid(item) ? [] : valid.errors).toEqual([]);
    expect(Object.keys(item).sort()).toEqual(
      ['credit', 'description', 'duration_ms', 'exclusive_available', 'governorate', 'height', 'listed_at', 'listing_id', 'material_types', 'material_version', 'offers', 'shot_list', 'shot_on', 'title', 'width'].sort(),
    );
    expect(item).toMatchObject({ governorate: 'gaza', shot_on: '2026-10-21', duration_ms: 125000, height: 2160, width: 3840, credit: 'Test Network', exclusive_available: false });
    const text = JSON.stringify(item);
    // 21:30 بتوقيت UTC يوم 20 هو بعد منتصف الليل في غزة: يوم التصوير محلي، والساعة لا تظهر
    for (const leak of ['secret-city', 'Hidden Alias', reporterId, a.materialId, a.originalId, '21:30']) expect([leak, text.includes(leak)]).toEqual([leak, false]);
    expect(item.offers).toEqual([
      { license_template_id: single, license_version: 1, type: 'editorial_single', name: { ar: 'ترخيص editorial_single', en: 'License editorial_single' }, price: { amount_minor: 4200, currency: 'ILS' } },
      { license_template_id: retired, license_version: 1, type: 'editorial_term', name: { ar: 'ترخيص editorial_term', en: 'License editorial_term' }, price: { amount_minor: 7000, currency: 'USD' } },
    ]);
    // قالب يُعطَّل بعد الإدراج يخرج عرضه من الكتالوج
    const current = (await get(admin, `/license-templates/${retired}`).expect(200)).body;
    const { id: _i, version: _v, created_at: _c, created_by: _b, ...input } = current;
    await http().put(`/v1/license-templates/${retired}`).set('Authorization', `Bearer ${admin.token}`).set('Idempotency-Key', randomUUID()).send({ ...input, enabled: false }).expect(200);
    expect((await get(finance, `/catalog/${a.listingId}`).expect(200)).body.offers.map((o: { license_template_id: string }) => o.license_template_id)).toEqual([single]);
    await get(finance, `/catalog/${draft.listingId}`).expect(404);
    expect(mine((await get(finance, `/catalog?q=${tag}&limit=100`).expect(200)).body)).not.toContain(draft.listingId);
  });

  it('filters by text, type, governorate, shooting day, duration, height, license type and exclusivity, and pages newest first with the cursor', async () => {
    const north = await listed({ title: 'north', governorate: 'north_gaza', height: 720, durationMs: 20000, shotAt: '2026-10-01T10:00:00Z' });
    const excl = await listed({ title: 'excl', height: 2160, durationMs: 300000, offers: [{ license_template_id: exclusive }] });
    const q = (s: string) => get(rights, `/catalog?q=${tag}&limit=100${s}`).expect(200).then((r) => mine(r.body));
    expect(await q('&governorate=north_gaza')).toEqual([north.listingId]);
    expect((await get(rights, `/catalog?q=${tag}%20north`).expect(200)).body.items.map((i: { listing_id: string }) => i.listing_id)).toEqual([north.listingId]);
    expect(await q('&shot_to=2026-10-02')).toEqual([north.listingId]);
    expect(await q('&min_height=2000')).toContain(excl.listingId);
    expect(await q('&min_height=2000')).not.toContain(north.listingId);
    expect(await q('&max_duration_ms=30000')).toEqual([north.listingId]);
    expect(await q('&license_type=exclusive_temporary')).toEqual([excl.listingId]);
    expect(await q('&exclusive_available=true')).toEqual([excl.listingId]);
    expect(await q('&exclusive_available=false')).not.toContain(excl.listingId);
    expect(await q('&material_type=report')).toEqual(expect.arrayContaining([north.listingId, excl.listingId]));
    expect(await q('&material_type=interview')).toEqual([]);

    const all = await q('');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ listing_id: string }>; next_cursor: string | null } = (await get(rights, `/catalog?q=${tag}&limit=1${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
      seen.push(...mine(page));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all);
    expect(all[0]).toBe(excl.listingId);
    await get(rights, '/catalog?cursor=nope').expect(400);
  });

  it('the preview link gives the watermarked preview only, after it is ready (409 before), and the preview is not in Material.files', async () => {
    const a = await listed();
    expect((await get(rights, `/catalog/${a.listingId}/preview-url`).expect(409)).body.code).toBe('preview_not_ready');
    await h.pool.query(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, mime_type, derived_from_id, verified_at)
       VALUES ($1, 'watermarked_preview', 'verified', 900, $2, $3, 'video/mp4', $4, now())`,
      [a.materialId, randomBytes(32), `derived/${a.materialId}/${a.originalId}/preview.mp4`, a.originalId],
    );
    const res = await get(finance, `/catalog/${a.listingId}/preview-url`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.url).toBe(`https://storage.test/${h.config.S3_BUCKET_MEDIA}/derived/${a.materialId}/${a.originalId}/preview.mp4?X-Amz-Expires=600`);
    expect(new Date(res.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
    const files = (await get(admin, `/materials/${a.materialId}`).expect(200)).body.files.map((f: { kind: string }) => f.kind);
    expect(files).not.toContain('watermarked_preview');
    await get(rights, `/catalog/${randomUUID()}/preview-url`).expect(404);

    // أصل أحدث يُتحقق منه بعد الإدراج: حدث بمصدره الجديد، والمعاينة القديمة لا تُعطى حتى تُبنى من الجديد
    const next = await seedUploadSession(h, reporterId, { state: 'completed' });
    await h.pool.query(`UPDATE upload_sessions SET material_id = $2, storage_key = $3 WHERE id = $1`, [next.id, a.materialId, `tus/${next.id}`]);
    const db = h.app.get<Database>(DB);
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, next.id));
      await recordVerification(tx, session!, { result: 'verified', sha256: randomBytes(32), sizeBytes: 1000 });
    });
    const { rows: verifiedRows } = await h.pool.query<{ id: string }>(`SELECT file_id AS id FROM upload_sessions WHERE id = $1`, [next.id]);
    const newOriginal = verifiedRows[0]!.id;
    const { rows: events } = await h.pool.query(
      `SELECT payload FROM outbox_events WHERE type = 'catalog.listing_changed' AND aggregate_id = $1 ORDER BY id DESC LIMIT 1`,
      [a.listingId],
    );
    expect(events[0].payload).toMatchObject({ listing_id: a.listingId, state: 'listed', source_file_id: newOriginal });
    expect((await get(finance, `/catalog/${a.listingId}/preview-url`).expect(409)).body.code).toBe('preview_not_ready');
    await h.pool.query(
      `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, mime_type, derived_from_id, verified_at)
       VALUES ($1, 'watermarked_preview', 'verified', 900, $2, $3, 'video/mp4', $4, now())`,
      [a.materialId, randomBytes(32), `derived/${a.materialId}/${newOriginal}/preview.mp4`, newOriginal],
    );
    expect((await get(finance, `/catalog/${a.listingId}/preview-url`).expect(200)).body.url).toContain(`/${newOriginal}/preview.mp4`);
  });

  it('catalog reads are for admin, rights, editor in chief and finance', async () => {
    await get(producer, '/catalog').expect(403);
    await get(producer, `/catalog/${randomUUID()}`).expect(403);
  });
});
