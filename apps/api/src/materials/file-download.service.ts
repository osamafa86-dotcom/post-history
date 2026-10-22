import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { auditLog, materialFiles } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { canEditMaterial, EDITOR_ONLY_KINDS, findScoped } from './material-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DERIVATIVE_KINDS = ['proxy', 'hls', 'audio', 'thumbnail', 'transcript', 'captions', 'shot_list'];
const TTL_SECONDS = 600;

/**
 * رابط قراءة موقّع لمشتق verified من مادة يراها المستدعي (عقد v0.1). الأصل والملاحظة الصوتية وكل ما لا يُرى 404 بلا
 * تفريق، والتفريغ والترجمة لمن يملك تعديل المادة وحده (R11). مفتاح التخزين بالمعرّفات وحدها فلا يحمل الرابط اسم ملف ولا
 * مراسل. الرابط نفسه لا يُسجَّل ولا يدخل التدقيق؛ إصداره يُدقَّق، وللنوعين النصيين قراءةً حساسة بنوعهما.
 */
@Injectable()
export class FileDownloadService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async downloadUrl(p: Principal, materialId: string, fileId: string): Promise<components['schemas']['FileDownloadUrl']> {
    const material = UUID.test(fileId) ? await findScoped(this.db, p, materialId) : undefined;
    if (!material || !this.storage.presignGet) throw ApiError.notFound();
    const [file] = await this.db
      .select({ id: materialFiles.id, kind: materialFiles.kind, storageKey: materialFiles.storageKey, derivedFromId: materialFiles.derivedFromId })
      .from(materialFiles)
      .where(
        and(
          eq(materialFiles.id, fileId),
          eq(materialFiles.materialId, materialId),
          eq(materialFiles.state, 'verified'),
          inArray(materialFiles.kind, DERIVATIVE_KINDS),
        ),
      );
    if (!file?.storageKey || (EDITOR_ONLY_KINDS.includes(file.kind) && !canEditMaterial(p, material))) throw ApiError.notFound();
    // مشتقات العامل في حاوية الوسائط، والوكيل المرفوع من العميل في حاوية الرفع
    const bucket = file.derivedFromId ? this.config.S3_BUCKET_MEDIA : this.config.S3_BUCKET_UPLOADS;
    const now = new Date();
    const url = this.storage.presignGet(bucket, file.storageKey, TTL_SECONDS, now);
    const sensitive = EDITOR_ONLY_KINDS.includes(file.kind);
    await this.db.insert(auditLog).values({
      actorId: p.userId,
      action: sensitive ? 'material.sensitive_read' : 'material_file.download_url_issued',
      targetType: sensitive ? 'material' : 'material_file',
      targetId: sensitive ? materialId : file.id,
      details: sensitive ? { material_id: materialId, file_id: file.id, field_keys: [file.kind] } : { material_id: materialId, file_id: file.id },
      hash: Buffer.alloc(32),
    });
    return { url, expires_at: new Date(now.getTime() + TTL_SECONDS * 1000).toISOString() };
  }
}
