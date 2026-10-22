import { Inject, Injectable } from '@nestjs/common';
import { and, eq, ne, sql, type SQL } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { DB, type Database, type Tx } from '../database/database.module';
import { materialExports, materialFiles, uploadSessions } from '../database/schema/schema';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { recordVerification, type UploadSessionRow, type VerificationOutcome } from '../verification/verification';
import type { components } from '../generated/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MediaSessionView = components['schemas']['MediaSession'];
export type MediaVerificationResult = components['schemas']['MediaVerificationResult'];
export type MediaVerificationBody = components['schemas']['MediaVerification'];
export type MediaDerivativeBody = components['schemas']['MediaDerivative'];
type MediaTechnical = components['schemas']['MediaTechnical'];

/** ما يُخزَّن في material_files.technical؛ يطابق material_file_technical_keys() في القاعدة. الباقي (المدة، بداية
 * الإطارات، الأبعاد) أعمدة. المخطط في العقد (MediaTechnical) مغلق، فلا يصل مفتاح خارج هذه القائمة أصلًا. */
const TECHNICAL_JSON_KEYS = [
  'container',
  'video_codec',
  'audio_codec',
  'frame_rate',
  'avg_frame_rate',
  'vfr',
  'frame_count',
  'max_frame_gap_ms',
  'has_gaps',
  'rotation',
  'hdr',
  'bit_depth',
  'audio_sample_rate',
  'audio_channels',
] as const;

function splitTechnical(t: MediaTechnical): {
  columns: { durationMs: number | null; startPtsUs: number | null; width: number | null; height: number | null };
  json: Record<string, unknown>;
} {
  const json: Record<string, unknown> = {};
  for (const k of TECHNICAL_JSON_KEYS) if (t[k] !== undefined) json[k] = t[k];
  // المصغّرة صورة: بلا مدة ولا بداية إطارات (العقد يلزمهما للتحقق وللمشتقات الزمنية وحدها)
  return { columns: { durationMs: t.duration_ms ?? null, startPtsUs: t.start_pts_us ?? null, width: t.width ?? null, height: t.height ?? null }, json };
}

// mime_type إلزامي للمصغّرة في العقد؛ للمشتقات الزمنية افتراضه بحسب النوع
const DEFAULT_MIME: Record<string, string> = { proxy: 'video/mp4', hls: 'application/vnd.apple.mpegurl', audio: 'audio/mp4', thumbnail: 'image/jpeg', watermarked_preview: 'video/mp4' };

const conflict = (msg: string) => new ApiError(409, 'upload_state_conflict', msg);
// الرمز صحيح (فحصه قبل هذه الطبقة، وفشله 404 لإخفاء النقطة) لكن الجلسة أو الملف المصدر غير موجود: حدث متقادم ينقله
// العامل إلى media:dead بدل إعادة المحاولة (عقد v0.1)
const gone = () => new ApiError(410, 'media_resource_gone', 'The upload session or source file does not exist.');

/**
 * جانب الخادم من واجهة عامل الوسائط (ADR 0006). الخادم يبقى الكاتب الوحيد: العامل يبلّغ ما حسبه، والخادم يتحقق
 * من الحجم في التخزين ويقرر مطابقة بصمة العميل بنفسه ثم يطبّق النتيجة بـ recordVerification نفسها التي يستعملها
 * المُتحقق داخل الخادم. كل نقطة متساوية الأثر لأن التسليم من الطابور «مرة على الأقل».
 */
const VOICE_NOTE_DERIVATIVES: ReadonlySet<string> = new Set(['audio', 'transcript', 'captions']);

@Injectable()
export class MediaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async session(id: string): Promise<MediaSessionView> {
    if (!UUID.test(id)) throw gone();
    const [s] = await this.db.select().from(uploadSessions).where(eq(uploadSessions.id, id));
    if (!s) throw gone();
    // بصمة العميل لا تُعاد: المقارنة في الخادم وحده
    return {
      material_id: s.materialId,
      kind: s.kind as MediaSessionView['kind'],
      state: s.state as MediaSessionView['state'],
      size_bytes: Number(s.sizeBytes),
      storage_key: s.storageKey,
      proxy_mode: s.proxyMode as MediaSessionView['proxy_mode'],
      material_has_proxy: await this.hasProxy(this.db, s.materialId),
    };
  }

  async verify(id: string, body: MediaVerificationBody): Promise<MediaVerificationResult> {
    if (!UUID.test(id)) throw gone();
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, id)).for('update');
      if (!s) throw gone();
      if (s.state !== 'completed') return this.replay(tx, s, body);

      const outcome = await this.decide(s, body);
      const applied = await recordVerification(tx, s, outcome);
      if (applied === 'applied' && outcome.result === 'verified') {
        const { columns, json } = splitTechnical(body.technical!);
        const [after] = await tx.select({ fileId: uploadSessions.fileId }).from(uploadSessions).where(eq(uploadSessions.id, s.id));
        await tx
          .update(materialFiles)
          .set({
            ...columns,
            technical: json,
            headSha256: Buffer.from(body.head_sha256!, 'hex'),
            tailSha256: Buffer.from(body.tail_sha256!, 'hex'),
            // البصمة الإدراكية (v0.2) للأصل وحده: كل عنصر 64 بت hex يُخزَّن bigint بإشارته
            ...(body.perceptual_hash && s.kind === 'original' ? { perceptualHash: perceptualArray(body.perceptual_hash) } : {}),
          })
          .where(eq(materialFiles.id, after!.fileId!));
      }
      return this.result(tx, s.id);
    });
  }

  /** ملف مصدر لمشتق عند الطلب (v0.3): معاينة الكتالوج وحزمة التصدير. مفتاح التخزين وبصمته وحدهما، بلا اسم ملف. */
  async file(fileId: string): Promise<components['schemas']['MediaSourceFile']> {
    if (!UUID.test(fileId)) throw gone();
    const [f] = await this.db.select().from(materialFiles).where(eq(materialFiles.id, fileId));
    if (!f?.storageKey) throw gone();
    return {
      file_id: f.id,
      material_id: f.materialId,
      kind: f.kind as components['schemas']['MediaSourceFile']['kind'],
      state: f.state as components['schemas']['MediaSourceFile']['state'],
      storage_key: f.storageKey,
      size_bytes: f.sizeBytes === null ? null : Number(f.sizeBytes),
      sha256: f.sha256 ? f.sha256.toString('hex') : null,
    };
  }

  async derive(fileId: string, body: MediaDerivativeBody): Promise<{ file_id: string }> {
    if (!UUID.test(fileId)) throw gone();
    return this.db.transaction(async (tx) => {
      const [source] = await tx.select().from(materialFiles).where(eq(materialFiles.id, fileId)).for('share');
      if (!source) throw gone();
      // الملاحظة الصوتية المتحقق منها مصدر لمشتقاتها الصوتية والنصية وحدها (تصميم الوكيل 5)؛ بقية المشتقات من الأصل
      const fromVoiceNote = source.kind === 'voice_note' && VOICE_NOTE_DERIVATIVES.has(body.kind);
      if ((source.kind !== 'original' && !fromVoiceNote) || source.state !== 'verified') {
        throw conflict('Derivatives are made from a verified original, or audio, transcript and captions from a verified voice note.');
      }
      // المشتق في مساحته وحدها: حاوية المشتقات (لا حاوية الرفع، فلا يُسجَّل كائن رفع مشتقًا)، تحت مسار مصدره
      if (!body.storage_key.startsWith(`derived/${source.materialId}/${source.id}/`) || body.storage_key.includes('..')) {
        throw ApiError.validation({ fields: ['/storage_key'] });
      }
      const head = await this.storage.head(this.config.S3_BUCKET_MEDIA, body.storage_key);
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
          mimeType: body.mime_type ?? DEFAULT_MIME[body.kind]!,
          // proxy_mode للنسخة الخفيفة وحدها (قيد material_files_proxy_mode_only_proxy)
          proxyMode: body.kind === 'proxy' ? 'normal' : null,
          verifiedAt: sql`now()` as never,
          ...columns,
          technical: json,
        })
        .onConflictDoNothing({ target: [materialFiles.derivedFromId, materialFiles.kind], where: sql`derived_from_id IS NOT NULL` })
        .returning({ id: materialFiles.id });
      if (created) {
        // حزمة التصدير (v0.2) تجعل طلبها جاهزًا
        if (body.kind === 'export') {
          await tx
            .update(materialExports)
            .set({ state: 'ready', fileId: created.id, failureReason: null })
            .where(eq(materialExports.sourceFileId, source.id));
        }
        return { file_id: created.id };
      }
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
      // فشل قرره الخادم من بلاغ «verified» (حجم أو بصمة عميل) يعود بالنتيجة نفسها عند تكرار البلاغ، وكذلك جلسة أُلغيت
      // لإبطال وصول صاحبها (aborted) أيًّا كان البلاغ: لا شيء للعامل يغيّره فيها
      const decidedByServer =
        s.failureReason === 'aborted' || (body.result === 'verified' && ['invalid_file', 'checksum_mismatch', 'storage_error'].includes(s.failureReason ?? ''));
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
      state: row!.state as MediaVerificationResult['state'],
      file_id: row!.fileId,
      receipt_number: row!.receipt ?? null,
      failure_reason: row!.failureReason as MediaVerificationResult['failure_reason'],
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

/** hex 64 بت → مصفوفة bigint في Postgres (القيمة بإشارتها، فالبت الأعلى يُحفظ). */
function perceptualArray(hashes: string[]): SQL {
  const values = hashes.map((h) => BigInt.asIntN(64, BigInt(`0x${h}`)).toString());
  return sql`${`{${values.join(',')}}`}::bigint[]`;
}
