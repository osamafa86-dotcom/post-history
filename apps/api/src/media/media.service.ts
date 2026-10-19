import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { DB, type Database, type Tx } from '../database/database.module';
import { materialFiles, uploadSessions } from '../database/schema/schema';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { recordVerification, type UploadSessionRow, type VerificationOutcome } from '../verification/verification';
import { type MediaDerivativeBody, type MediaVerificationBody, splitTechnical } from './media-schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MediaSessionView {
  material_id: string;
  kind: string;
  state: string;
  size_bytes: number;
  storage_key: string | null;
  proxy_mode: string | null;
  material_has_proxy: boolean;
}

export interface MediaVerificationResult {
  state: 'verified' | 'failed';
  file_id: string | null;
  receipt_number: string | null;
  failure_reason: string | null;
}

const conflict = (msg: string) => new ApiError(409, 'upload_state_conflict', msg);

/**
 * جانب الخادم من واجهة عامل الوسائط (ADR 0006). الخادم يبقى الكاتب الوحيد: العامل يبلّغ ما حسبه، والخادم يتحقق
 * من الحجم في التخزين ويقرر مطابقة بصمة العميل بنفسه ثم يطبّق النتيجة بـ recordVerification نفسها التي يستعملها
 * المُتحقق داخل الخادم. كل نقطة متساوية الأثر لأن التسليم من الطابور «مرة على الأقل».
 */
@Injectable()
export class MediaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async session(id: string): Promise<MediaSessionView> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [s] = await this.db.select().from(uploadSessions).where(eq(uploadSessions.id, id));
    if (!s) throw ApiError.notFound();
    // بصمة العميل لا تُعاد: المقارنة في الخادم وحده
    return {
      material_id: s.materialId,
      kind: s.kind,
      state: s.state,
      size_bytes: Number(s.sizeBytes),
      storage_key: s.storageKey,
      proxy_mode: s.proxyMode,
      material_has_proxy: await this.hasProxy(this.db, s.materialId),
    };
  }

  async verify(id: string, body: MediaVerificationBody): Promise<MediaVerificationResult> {
    if (!UUID.test(id)) throw ApiError.notFound();
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, id)).for('update');
      if (!s) throw ApiError.notFound();
      if (s.state !== 'completed') return this.replay(tx, s, body);

      const outcome = await this.decide(s, body);
      await recordVerification(tx, s, outcome);
      if (outcome.result === 'verified') {
        const { columns, json } = splitTechnical(body.technical!);
        const [after] = await tx.select({ fileId: uploadSessions.fileId }).from(uploadSessions).where(eq(uploadSessions.id, s.id));
        await tx
          .update(materialFiles)
          .set({
            ...columns,
            technical: json,
            headSha256: Buffer.from(body.head_sha256!, 'hex'),
            tailSha256: Buffer.from(body.tail_sha256!, 'hex'),
          })
          .where(eq(materialFiles.id, after!.fileId!));
      }
      return this.result(tx, s.id);
    });
  }

  async derive(fileId: string, body: MediaDerivativeBody): Promise<{ file_id: string }> {
    if (!UUID.test(fileId)) throw ApiError.notFound();
    return this.db.transaction(async (tx) => {
      const [source] = await tx.select().from(materialFiles).where(eq(materialFiles.id, fileId)).for('share');
      if (!source) throw ApiError.notFound();
      if (source.kind !== 'original' || source.state !== 'verified') throw conflict('Derivatives are made from a verified original only.');
      // المشتق في مساحته وحدها: لا يشير العامل إلى كائن مادة أخرى أو إلى الأصل نفسه
      if (!body.storage_key.startsWith(`derived/${source.materialId}/${source.id}/`) || body.storage_key.includes('..')) {
        throw ApiError.validation({ fields: ['/storage_key'] });
      }
      const head = await this.storage.head(this.config.S3_BUCKET_UPLOADS, body.storage_key);
      if (!head || head.size !== body.size_bytes) throw ApiError.validation({ fields: ['/storage_key', '/size_bytes'] });

      const sha256 = Buffer.from(body.sha256, 'hex');
      const { columns, json } = splitTechnical(body.technical);
      const [created] = await tx
        .insert(materialFiles)
        .values({
          materialId: source.materialId,
          kind: body.kind,
          state: 'verified',
          derivedFromId: source.id,
          storageKey: body.storage_key,
          sizeBytes: body.size_bytes,
          sha256,
          mimeType: 'video/mp4',
          proxyMode: 'normal',
          verifiedAt: sql`now()` as never,
          ...columns,
          technical: json,
        })
        .onConflictDoNothing({ target: [materialFiles.derivedFromId, materialFiles.kind], where: sql`derived_from_id IS NOT NULL` })
        .returning({ id: materialFiles.id });
      if (created) return { file_id: created.id };
      // تكرار: الطلب نفسه يعيد الملف نفسه؛ مشتق مختلف للمصدر والنوع نفسيهما تعارض
      const [existing] = await tx
        .select()
        .from(materialFiles)
        .where(and(eq(materialFiles.derivedFromId, source.id), eq(materialFiles.kind, body.kind)));
      if (existing && existing.storageKey === body.storage_key && existing.sha256?.equals(sha256)) return { file_id: existing.id };
      throw conflict('A different derivative of this kind already exists for this file.');
    });
  }

  /** ما يقرره الخادم من بلاغ العامل: الحجم مقابل الجلسة والتخزين، وبصمة العميل مقابل البصمة المحسوبة. */
  private async decide(s: UploadSessionRow, body: MediaVerificationBody): Promise<VerificationOutcome> {
    if (body.result !== 'verified') return { result: 'failed', reason: body.result };
    if (!s.storageKey) return { result: 'failed', reason: 'storage_error' };
    // عطل التخزين هنا يرمي (500) فيعيد العامل المحاولة؛ غياب الكائن نتيجة نهائية
    const head = await this.storage.head(this.config.S3_BUCKET_UPLOADS, s.storageKey);
    if (!head) return { result: 'failed', reason: 'storage_error' };
    if (body.size_bytes !== Number(s.sizeBytes) || head.size !== body.size_bytes) return { result: 'failed', reason: 'invalid_file' };
    const sha256 = Buffer.from(body.sha256!, 'hex');
    if (s.clientSha256 && !s.clientSha256.equals(sha256)) return { result: 'failed', reason: 'checksum_mismatch' };
    return { result: 'verified', sha256, sizeBytes: body.size_bytes };
  }

  /** الجلسة قُضي فيها: الطلب المكرر الموافق للنتيجة المسجلة = 200 بها، والمخالف = 409. */
  private async replay(tx: Tx, s: UploadSessionRow, body: MediaVerificationBody): Promise<MediaVerificationResult> {
    if (s.state === 'verified' && body.result === 'verified') {
      const [file] = await tx.select({ sha256: materialFiles.sha256 }).from(materialFiles).where(eq(materialFiles.id, s.fileId!));
      if (file?.sha256?.equals(Buffer.from(body.sha256!, 'hex'))) return this.result(tx, s.id);
    } else if (s.state === 'failed') {
      // فشل قرره الخادم من بلاغ «verified» (حجم أو بصمة عميل) يعود بالنتيجة نفسها عند تكرار البلاغ
      const decidedByServer = body.result === 'verified' && ['invalid_file', 'checksum_mismatch', 'storage_error'].includes(s.failureReason ?? '');
      if (decidedByServer || body.result === s.failureReason) return this.result(tx, s.id);
    }
    throw conflict(`The upload session is ${s.state}.`);
  }

  private async result(tx: Tx, sessionId: string): Promise<MediaVerificationResult> {
    const [row] = await tx
      .select({ state: uploadSessions.state, fileId: uploadSessions.fileId, failureReason: uploadSessions.failureReason, receipt: materialFiles.receiptNumber })
      .from(uploadSessions)
      .leftJoin(materialFiles, eq(materialFiles.id, uploadSessions.fileId))
      .where(eq(uploadSessions.id, sessionId));
    return {
      state: row!.state as 'verified' | 'failed',
      file_id: row!.fileId,
      receipt_number: row!.receipt ?? null,
      failure_reason: row!.failureReason,
    };
  }

  private async hasProxy(db: Database | Tx, materialId: string): Promise<boolean> {
    const [p] = await db
      .select({ id: materialFiles.id })
      .from(materialFiles)
      .where(and(eq(materialFiles.materialId, materialId), eq(materialFiles.kind, 'proxy'), ne(materialFiles.state, 'failed')))
      .limit(1);
    return Boolean(p);
  }
}
