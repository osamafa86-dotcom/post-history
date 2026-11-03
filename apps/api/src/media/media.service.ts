import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { ApiError } from '../common/errors';
import { DB, type Database, type Tx } from '../database/database.module';
import { licenses, materialExports, materialFiles, materialRenders, uploadSessions } from '../database/schema/schema';
import { writeOutboxEvent } from '../outbox/outbox';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { recordVerification, type UploadSessionRow, type VerificationOutcome } from '../verification/verification';
import type { components } from '../generated/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MediaSessionView = components['schemas']['MediaSession'];
export type MediaVerificationResult = components['schemas']['MediaVerificationResult'];
export type MediaVerificationBody = components['schemas']['MediaVerification'];
export type MediaDerivativeBody = components['schemas']['MediaDerivative'];
export type MediaAlignmentBody = components['schemas']['MediaAlignment'];
export type MediaRenderJob = components['schemas']['MediaRenderJob'];
export type MediaRenderFailureBody = components['schemas']['MediaRenderFailure'];
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
const renderGone = () => new ApiError(410, 'media_resource_gone', 'The render does not exist.');
const renderConflict = (state: string) => new ApiError(409, 'upload_state_conflict', `The render is ${state}.`);

// فرادة (المصدر، النوع) لكل مشتق عدا حزمة التسليم (لكل ترخيص) ونسخة القالب (لكل طلب، material_renders.file_id)؛
// الشرط حرفيًا شرط الفهرس الجزئي (ترحيل 038) فيستدلّه Postgres
const DERIVED_KIND_UNIQUE = sql`derived_from_id IS NOT NULL AND kind NOT IN ('delivery', 'circulated_render')`;

/**
 * جانب الخادم من واجهة عامل الوسائط (ADR 0006). الخادم يبقى الكاتب الوحيد: العامل يبلّغ ما حسبه، والخادم يتحقق
 * من الحجم في التخزين ويقرر مطابقة بصمة العميل بنفسه ثم يطبّق النتيجة بـ recordVerification نفسها التي يستعملها
 * المُتحقق داخل الخادم. كل نقطة متساوية الأثر لأن التسليم من الطابور «مرة على الأقل».
 */
const VOICE_NOTE_DERIVATIVES: ReadonlySet<string> = new Set(['audio', 'transcript', 'captions']);
const EDITORIAL_ONLY: ReadonlySet<string> = new Set(['transcript', 'captions', 'shot_list']);

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
      proxy_file_id: await this.latestVerified(this.db, s.materialId, 'proxy'),
      original_file_id: await this.latestVerified(this.db, s.materialId, 'original'),
    };
  }

  /**
   * المحاذاة الصوتية (v0.3، #249): يستبدل ما قاسه العامل على النسخة الخفيفة، فالطلب نفسه يعيد الأثر نفسه. النسخة
   * الخفيفة والأصل كلاهما متحقق ومن المادة نفسها، وإلا 422 بمسار الحقل؛ الملف غير الموجود 410 كبقية نقاط العامل.
   */
  async putAlignment(fileId: string, body: MediaAlignmentBody): Promise<void> {
    if (!UUID.test(fileId)) throw gone();
    await this.db.transaction(async (tx) => {
      const [proxy] = await tx.select().from(materialFiles).where(eq(materialFiles.id, fileId)).for('update');
      if (!proxy) throw gone();
      if (proxy.kind !== 'proxy' || proxy.state !== 'verified') throw ApiError.validation({ fields: ['/file_id'] });
      const [original] = await tx
        .select({ materialId: materialFiles.materialId, kind: materialFiles.kind, state: materialFiles.state })
        .from(materialFiles)
        .where(eq(materialFiles.id, body.original_file_id));
      if (!original || original.kind !== 'original' || original.state !== 'verified' || original.materialId !== proxy.materialId) {
        throw ApiError.validation({ fields: ['/original_file_id'] });
      }
      await tx
        .update(materialFiles)
        .set({
          alignmentOriginalFileId: body.original_file_id,
          alignmentOffsetMs: body.offset_ms,
          alignmentConfidence: body.confidence,
          alignmentMargin: body.margin,
          alignmentReliable: body.reliable,
          alignedAt: sql`now()`,
        })
        .where(eq(materialFiles.id, fileId));
    });
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

  /**
   * ملف مصدر لما يبنيه العامل عند الطلب (v0.3): المحاذاة، وحزمة التصدير، ومعاينة الكتالوج، وحزمة التسليم. مفتاح التخزين
   * وبصمته وحدهما، بلا اسم ملف ولا بيانات كاشفة. التفريغ والترجمة وقائمة اللقطات لا تُعطى (R11، threat-model §9.1):
   * لا تدخل شيئًا مما يبنيه العامل، فطلبها 410 كالملف غير الموجود.
   */
  async file(fileId: string): Promise<components['schemas']['MediaSourceFile']> {
    if (!UUID.test(fileId)) throw gone();
    const [f] = await this.db.select().from(materialFiles).where(eq(materialFiles.id, fileId));
    if (!f?.storageKey || EDITORIAL_ONLY.has(f.kind)) throw gone();
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
      if (body.kind === 'circulated_render') return this.registerRender(tx, source, body, sha256, columns, json);
      if (body.kind === 'delivery') return this.registerDelivery(tx, source, body, sha256, columns, json);
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
        .onConflictDoNothing({ target: [materialFiles.derivedFromId, materialFiles.kind], where: DERIVED_KIND_UNIQUE })
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

  /**
   * حزمة تسليم ترخيص (ADR 0025 الجزء 9): لكل ترخيص حزمته، من أصل مادة الترخيص نفسها. `license_id` يُكتب في الصف (قيد
   * material_files_delivery_license_check)، والترخيص المجهول أو ترخيص مادة أخرى 422 قبل أي كتابة. متساوٍ الأثر على
   * (المصدر، الترخيص): الطلب نفسه يعيد الملف نفسه، وحزمة مختلفة للترخيص والمصدر نفسيهما 409.
   */
  private async registerDelivery(
    tx: Tx,
    source: typeof materialFiles.$inferSelect,
    body: MediaDerivativeBody,
    sha256: Buffer,
    columns: ReturnType<typeof splitTechnical>['columns'],
    json: Record<string, unknown>,
  ): Promise<{ file_id: string }> {
    const licenseId = body.license_id!;
    const [license] = await tx.select({ materialId: licenses.materialId }).from(licenses).where(eq(licenses.id, licenseId));
    if (!license || license.materialId !== source.materialId) throw ApiError.validation({ fields: ['/license_id'] });
    const [created] = await tx
      .insert(materialFiles)
      .values({
        materialId: source.materialId,
        kind: 'delivery',
        state: 'verified',
        derivedFromId: source.id,
        licenseId,
        storageKey: body.storage_key,
        sizeBytes: body.size_bytes,
        sha256,
        mimeType: body.mime_type!,
        verifiedAt: sql`now()` as never,
        ...columns,
        technical: json,
      })
      // الشرط حرفيًا شرط الفهرس الجزئي material_files_delivery_license_key فيستدلّه Postgres
      .onConflictDoNothing({ target: [materialFiles.derivedFromId, materialFiles.licenseId], where: sql`kind = 'delivery'` })
      .returning({ id: materialFiles.id });
    if (created) return { file_id: created.id };
    const [existing] = await tx
      .select()
      .from(materialFiles)
      .where(and(eq(materialFiles.derivedFromId, source.id), eq(materialFiles.licenseId, licenseId), eq(materialFiles.kind, 'delivery')));
    if (existing && existing.storageKey === body.storage_key && existing.sha256?.equals(sha256)) return { file_id: existing.id };
    throw conflict('A different delivery package is already registered for this license.');
  }

  /**
   * نسخة قالب «مواد متداولة» (ADR 0091): لكل نسخة ملفها. صف النسخة مقفول حتى نهاية المعاملة فلا يسجّل تسليمان ملفين لها،
   * والتكرار بالملف نفسه يعيده. التسجيل يجعل النسخة ready ويكتب render.completed في المعاملة نفسها.
   */
  private async registerRender(
    tx: Tx,
    source: typeof materialFiles.$inferSelect,
    body: MediaDerivativeBody,
    sha256: Buffer,
    columns: ReturnType<typeof splitTechnical>['columns'],
    json: Record<string, unknown>,
  ): Promise<{ file_id: string }> {
    const [render] = await tx.select().from(materialRenders).where(eq(materialRenders.id, body.render_id!)).for('update');
    if (!render) throw renderGone();
    if (render.sourceFileId !== source.id) throw ApiError.validation({ fields: ['/render_id'] });
    if (render.fileId) {
      const [existing] = await tx.select().from(materialFiles).where(eq(materialFiles.id, render.fileId));
      if (existing && existing.storageKey === body.storage_key && existing.sha256?.equals(sha256)) return { file_id: existing.id };
      throw conflict('A different file is already registered for this render.');
    }
    // العامل يلتقط النسخة قبل أي عمل (start)، والفاشلة نهائية
    if (render.state !== 'rendering') throw renderConflict(render.state);
    const [created] = await tx
      .insert(materialFiles)
      .values({
        materialId: source.materialId,
        kind: 'circulated_render',
        state: 'verified',
        derivedFromId: source.id,
        storageKey: body.storage_key,
        sizeBytes: body.size_bytes,
        sha256,
        mimeType: body.mime_type!,
        verifiedAt: sql`now()` as never,
        ...columns,
        technical: json,
      })
      .returning({ id: materialFiles.id });
    const fileId = created!.id;
    await tx.update(materialRenders).set({ state: 'ready', fileId, completedAt: sql`now()` }).where(eq(materialRenders.id, render.id));
    await writeOutboxEvent(tx, {
      type: 'render.completed',
      aggregateType: 'material',
      aggregateId: render.materialId,
      idempotencyKey: `render.completed:${render.id}`,
      payload: { material_id: render.materialId, render_id: render.id, file_id: fileId },
    });
    return { file_id: fileId };
  }

  /** معاملات النسخة كما يمررها العامل إلى القالب؛ النصوص تعبر الشبكة الداخلية وحدها ولا تُسجَّل. */
  async render(renderId: string): Promise<MediaRenderJob> {
    if (!UUID.test(renderId)) throw renderGone();
    const [r] = await this.db.select().from(materialRenders).where(eq(materialRenders.id, renderId));
    if (!r) throw renderGone();
    return {
      render_id: r.id,
      material_id: r.materialId,
      source_file_id: r.sourceFileId,
      state: r.state as MediaRenderJob['state'],
      template: r.template as MediaRenderJob['template'],
      aspect: r.aspect as MediaRenderJob['aspect'],
      title_lines: r.titleLines,
      location_text: r.locationText,
      label: r.label as MediaRenderJob['label'],
    };
  }

  /** الالتقاط: requested ← rendering بـ started_at وحدث render.started. الملتقطة تُعاد بلا حدث (إعادة تسليم). */
  async startRender(renderId: string): Promise<void> {
    if (!UUID.test(renderId)) throw renderGone();
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(materialRenders).where(eq(materialRenders.id, renderId)).for('update');
      if (!r) throw renderGone();
      if (r.state === 'rendering') return;
      if (r.state !== 'requested') throw renderConflict(r.state);
      await tx.update(materialRenders).set({ state: 'rendering', startedAt: sql`now()` }).where(eq(materialRenders.id, r.id));
      await writeOutboxEvent(tx, {
        type: 'render.started',
        aggregateType: 'material',
        aggregateId: r.materialId,
        idempotencyKey: `render.started:${r.id}`,
        payload: { material_id: r.materialId, render_id: r.id },
      });
    });
  }

  /** الفشل بسبب مرمّز، من requested أو rendering؛ الفاشلة تُعاد بسببها الأول بلا حدث، والجاهزة 409. */
  async failRender(renderId: string, body: MediaRenderFailureBody): Promise<void> {
    if (!UUID.test(renderId)) throw renderGone();
    await this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(materialRenders).where(eq(materialRenders.id, renderId)).for('update');
      if (!r) throw renderGone();
      if (r.state === 'failed') return;
      if (r.state === 'ready') throw renderConflict(r.state);
      await tx
        .update(materialRenders)
        .set({ state: 'failed', failureReason: body.reason, completedAt: sql`now()` })
        .where(eq(materialRenders.id, r.id));
      await writeOutboxEvent(tx, {
        type: 'render.failed',
        aggregateType: 'material',
        aggregateId: r.materialId,
        idempotencyKey: `render.failed:${r.id}`,
        payload: { material_id: r.materialId, render_id: r.id, failure_reason: body.reason },
      });
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
      if (file?.sha256?.equals(Buffer.from(body.sha256!, 'hex'))) {
        await this.fillProbe(tx, s.fileId!, body.technical!);
        return this.result(tx, s.id);
      }
    } else if (s.state === 'failed') {
      // فشل قرره الخادم من بلاغ «verified» (حجم أو بصمة عميل) يعود بالنتيجة نفسها عند تكرار البلاغ، وكذلك جلسة أُلغيت
      // لإبطال وصول صاحبها (aborted) أيًّا كان البلاغ: لا شيء للعامل يغيّره فيها
      const decidedByServer =
        s.failureReason === 'aborted' || (body.result === 'verified' && ['invalid_file', 'checksum_mismatch', 'storage_error'].includes(s.failureReason ?? ''));
      if (decidedByServer || body.result === s.failureReason) return this.result(tx, s.id);
    }
    throw conflict(`The upload session is ${s.state}.`);
  }

  /**
   * المتحقق داخل الخادم (UPLOAD_VERIFIER=in_process، المعاينة الخفيفة، ADR 0092) يطابق البصمة ولا يفحص الملف، فلا بيانات
   * فنية للأصل. تقرير العامل المطابق لجلسة متحققة (مسار الاستئناف) يملأ الفارغ منها، كل عمود وحده، ولا يستبدل قيمة مسجلة؛
   * الحالة والبصمة والإيصال لا تتغير. شرط `source` لنسخ القالب (ADR 0091) يقرأ المدة و`video_codec` من هنا.
   */
  private async fillProbe(tx: Tx, fileId: string, technical: MediaTechnical): Promise<void> {
    const { columns, json } = splitTechnical(technical);
    await tx
      .update(materialFiles)
      .set({
        durationMs: sql`coalesce(${materialFiles.durationMs}, ${columns.durationMs}::bigint)`,
        startPtsUs: sql`coalesce(${materialFiles.startPtsUs}, ${columns.startPtsUs}::bigint)`,
        width: sql`coalesce(${materialFiles.width}, ${columns.width}::integer)`,
        height: sql`coalesce(${materialFiles.height}, ${columns.height}::integer)`,
        technical: sql`coalesce(${materialFiles.technical}, ${JSON.stringify(json)}::jsonb)`,
      })
      .where(and(eq(materialFiles.id, fileId), or(isNull(materialFiles.technical), isNull(materialFiles.durationMs))));
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

  private async latestVerified(db: Database | Tx, materialId: string, kind: 'proxy' | 'original'): Promise<string | null> {
    const [f] = await db
      .select({ id: materialFiles.id })
      .from(materialFiles)
      .where(and(eq(materialFiles.materialId, materialId), eq(materialFiles.kind, kind), eq(materialFiles.state, 'verified')))
      .orderBy(desc(materialFiles.verifiedAt), desc(materialFiles.id))
      .limit(1);
    return f?.id ?? null;
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
