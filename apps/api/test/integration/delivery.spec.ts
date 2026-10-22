import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { requestDelivery, type DeliveryRequest } from '../../src/commerce/delivery';
import { schemaFileValidator } from '../../src/common/contract';
import { ApiError } from '../../src/common/errors';
import { DB, type Database } from '../../src/database/database.module';
import { outboxEvents } from '../../src/database/schema/schema';
import { isMediaEvent } from '../../src/outbox/media-stream';
import { serializeOutboxEvent } from '../../src/outbox/outbox';
import { createHarness, type Harness, seedUploadSession, seedUser } from './harness';

// طلب حزمة تسليم المشتري (ADR 0025 الجزء 9، R11): الحدث بالمعرّفات ومواصفات التسليم وحدها، والنسخة المنتَجة من القائمة
// البيضاء لأنواعها وحدها، فلا يدخل الحزمة تفريغ ولا ترجمة ولا قائمة لقطات ولا مشتق تحريري (ملاحظة الأمن على #276)
describe('buyer delivery request (license.delivery_requested)', () => {
  let h: Harness;
  let db: Database;
  let reporterId: string;
  beforeAll(async () => {
    h = await createHarness();
    db = h.app.get(DB);
    reporterId = (await seedUser(h)).id;
  });
  afterAll(() => h.close());

  const KINDS = ['original', 'proxy', 'hls', 'audio', 'thumbnail', 'voice_note', 'export', 'transcript', 'captions', 'watermarked_preview', 'shot_list', 'delivery'];
  const material = async () => (await seedUploadSession(h, reporterId)).materialId;
  const file = async (materialId: string, kind: string, opts: { derivedFrom?: string; state?: string } = {}) =>
    (
      await h.pool.query<{ id: string }>(
        `INSERT INTO material_files (material_id, kind, state, size_bytes, sha256, storage_key, verified_at, derived_from_id, license_id)
         VALUES ($1, $2, $3, 100, $4, $5, CASE WHEN $3 = 'verified' THEN now() END, $6, $7) RETURNING id`,
        [
          materialId,
          kind,
          opts.state ?? 'verified',
          randomBytes(32),
          `derived/${materialId}/${randomBytes(6).toString('hex')}/${kind}`,
          opts.derivedFrom ?? null,
          kind === 'delivery' ? randomUUID() : null,
        ],
      )
    ).rows[0]!.id;
  const request = (req: Partial<DeliveryRequest> & { materialId: string }) =>
    db.transaction((tx) => requestDelivery(tx, { licenseId: randomUUID(), deliverables: ['original'], actorId: null, ...req }));
  const events = async (licenseId: string) =>
    (await h.pool.query(`SELECT * FROM outbox_events WHERE type = 'license.delivery_requested' AND aggregate_id = $1`, [licenseId])).rows;
  const refused = async (req: Partial<DeliveryRequest> & { materialId: string }, field: string) => {
    const licenseId = randomUUID();
    const err = await request({ ...req, licenseId }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect([(err as ApiError).status, (err as ApiError).code, (err as ApiError).details]).toEqual([422, 'validation_failed', { fields: [field] }]);
    expect(await events(licenseId)).toEqual([]);
  };

  it('writes the event from the latest verified original, ids and deliverables only, in the contract shape, once per license and source', async () => {
    const m = await material();
    await file(m, 'original');
    const latest = await file(m, 'original');
    const licenseId = randomUUID();
    expect(await request({ materialId: m, licenseId, deliverables: ['original', 'audio', 'stills'] })).toEqual({ sourceFileId: latest });
    await request({ materialId: m, licenseId, deliverables: ['original', 'audio', 'stills'] });
    const rows = await events(licenseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ license_id: licenseId, material_id: m, source_file_id: latest, deliverables: ['original', 'audio', 'stills'], produced_file_id: null });
    const valid = schemaFileValidator('outbox-event.json');
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, licenseId));
    const event = serializeOutboxEvent(row!);
    expect(valid(event) ? [] : valid.errors).toEqual([]);
    expect(isMediaEvent(row!)).toBe(true);
  });

  it('refuses a produced_file_id of every kind the contract knows, editorial derivatives first (422 /produced_file_id)', async () => {
    const m = await material();
    const original = await file(m, 'original');
    for (const kind of KINDS) {
      const derived = kind === 'original' || kind === 'voice_note' ? {} : { derivedFrom: original };
      const id = await file(m, kind, derived);
      await refused({ materialId: m, deliverables: ['original', 'produced'], producedFileId: id }, '/produced_file_id');
    }
  });

  it('refuses produced without a file, a file without produced, a file of another material or unknown, and bad deliverables', async () => {
    const m = await material();
    const original = await file(m, 'original');
    const proxy = await file(m, 'proxy', { derivedFrom: original });
    const other = await material();
    const foreign = await file(other, 'proxy', { derivedFrom: await file(other, 'original') });
    await refused({ materialId: m, deliverables: ['produced'] }, '/produced_file_id');
    await refused({ materialId: m, deliverables: ['original'], producedFileId: proxy }, '/produced_file_id');
    await refused({ materialId: m, deliverables: ['produced'], producedFileId: foreign }, '/produced_file_id');
    await refused({ materialId: m, deliverables: ['produced'], producedFileId: randomUUID() }, '/produced_file_id');
    await refused({ materialId: m, deliverables: ['produced'], producedFileId: 'not-a-uuid' }, '/produced_file_id');
    await refused({ materialId: m, deliverables: ['original', 'transcript'] }, '/deliverables');
    await refused({ materialId: m, deliverables: ['original', 'original'] }, '/deliverables');
    await refused({ materialId: m, deliverables: [] }, '/deliverables');
  });

  it('a material without a verified original cannot be delivered (409)', async () => {
    const m = await material();
    await file(m, 'original', { state: 'received' });
    const err = await request({ materialId: m }).catch((e: unknown) => e);
    expect([(err as ApiError).status, (err as ApiError).code]).toEqual([409, 'upload_state_conflict']);
  });
});
