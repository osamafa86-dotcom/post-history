import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError, StoredResponse } from '../common/errors';
import { DB, type Database, type Executor } from '../database/database.module';
import { auditLog, materialExports, materialFiles } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { writeOutboxEvent } from '../outbox/outbox';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { findScoped, iso } from './material-store';

type MaterialExport = components['schemas']['MaterialExport'];
const TTL_SECONDS = 600;

/**
 * حزمة التصدير لبرامج المونتاج (عقد v0.2، #99): تُبنى عند الطلب لا عند الاستيعاب. طلب لكل أصل (أحدث أصل متحقق
 * للمادة)، وحدث export.requested بالمعرّفات وحدها في المعاملة نفسها يأخذه عامل الوسائط ويسجّل الحزمة مشتقًا export.
 * الحزمة لا تحمل بيانات كاشفة مهما كانت صلاحيات الطالب، فلا يحمل الحدث صلاحيات (CLAUDE.md §5).
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async status(p: Principal, materialId: string): Promise<MaterialExport> {
    if (!(await findScoped(this.db, p, materialId))) throw ApiError.notFound();
    const source = await latestOriginal(this.db, materialId);
    if (!source) return none(null);
    const [row] = await this.db.select().from(materialExports).where(eq(materialExports.sourceFileId, source));
    return row ? toDto(row) : none(source);
  }

  /** 202 لطلب جديد أو إعادة طلب فشل، و200 (StoredResponse) لطلب قائم جاهز أو قيد البناء دون حدث جديد. */
  async request(p: Principal, materialId: string): Promise<MaterialExport> {
    return this.db.transaction(async (tx) => {
      const m = await findScoped(tx, p, materialId, { forUpdate: true });
      if (!m) throw ApiError.notFound();
      const source = await latestOriginal(tx, materialId);
      if (!source) throw new ApiError(409, 'upload_state_conflict', 'The material has no verified original to export.');
      const [existing] = await tx.select().from(materialExports).where(eq(materialExports.sourceFileId, source)).for('update');
      if (existing && existing.state !== 'failed') throw new StoredResponse(200, toDto(existing));
      const [row] = existing
        ? await tx
            .update(materialExports)
            .set({ state: 'requested', failureReason: null, fileId: null, requestedBy: p.userId, requestedAt: sql`now()` })
            .where(eq(materialExports.sourceFileId, source))
            .returning()
        : await tx.insert(materialExports).values({ sourceFileId: source, materialId, requestedBy: p.userId }).returning();
      await writeOutboxEvent(tx, {
        type: 'export.requested',
        aggregateType: 'material',
        aggregateId: materialId,
        idempotencyKey: `export.requested:${source}:${row!.requestedAt}`,
        actorId: p.userId,
        payload: { material_id: materialId, source_file_id: source, requested_by: p.userId },
      });
      return toDto(row!);
    });
  }

  /** رابط الحزمة الجاهزة، كرابط المشتقات (≤ 10 دقائق، بالمعرّفات وحدها)، ويُسجَّل إصداره في التدقيق. */
  async downloadUrl(p: Principal, materialId: string): Promise<components['schemas']['FileDownloadUrl']> {
    if (!(await findScoped(this.db, p, materialId)) || !this.storage.presignGet) throw ApiError.notFound();
    const source = await latestOriginal(this.db, materialId);
    const [row] = source
      ? await this.db
          .select({ state: materialExports.state, fileId: materialExports.fileId, storageKey: materialFiles.storageKey })
          .from(materialExports)
          .leftJoin(materialFiles, eq(materialFiles.id, materialExports.fileId))
          .where(eq(materialExports.sourceFileId, source))
      : [];
    if (!row || row.state !== 'ready' || !row.fileId || !row.storageKey) {
      throw new ApiError(409, 'export_not_ready', 'The export package is not ready.');
    }
    const now = new Date();
    const url = this.storage.presignGet(this.config.S3_BUCKET_MEDIA, row.storageKey, TTL_SECONDS, now);
    await this.db.insert(auditLog).values({
      actorId: p.userId,
      action: 'material_export.download_url_issued',
      targetType: 'material_file',
      targetId: row.fileId,
      details: { material_id: materialId, file_id: row.fileId },
      hash: Buffer.alloc(32),
    });
    return { url, expires_at: new Date(now.getTime() + TTL_SECONDS * 1000).toISOString() };
  }
}

async function latestOriginal(executor: Executor, materialId: string): Promise<string | null> {
  const [f] = await executor
    .select({ id: materialFiles.id })
    .from(materialFiles)
    .where(and(eq(materialFiles.materialId, materialId), eq(materialFiles.kind, 'original'), eq(materialFiles.state, 'verified')))
    .orderBy(desc(materialFiles.verifiedAt), desc(materialFiles.id))
    .limit(1);
  return f?.id ?? null;
}

function none(source: string | null): MaterialExport {
  return { state: 'none', source_file_id: source, file_id: null, requested_by: null, requested_at: null, failure_reason: null };
}

function toDto(r: typeof materialExports.$inferSelect): MaterialExport {
  return {
    state: r.state as MaterialExport['state'],
    source_file_id: r.sourceFileId,
    file_id: r.fileId,
    requested_by: r.requestedBy,
    requested_at: iso(r.requestedAt),
    failure_reason: r.failureReason as MaterialExport['failure_reason'],
  };
}
