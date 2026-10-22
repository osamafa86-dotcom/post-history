import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Request } from 'express';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { randomToken, sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { LOGGER } from '../common/logger';
import { DB, type Database } from '../database/database.module';
import { materialFiles, uploadSessions } from '../database/schema/schema';
import type { components } from '../generated/api';
import { hasRole, type Principal } from '../identity/principal';
import type { ReplayRehydrator } from '../idempotency/replay';
import { findScoped, iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';
import { OBJECT_STORAGE, type ObjectStorage } from '../verification/object-storage';
import { failCompletedOriginal, markUploadFailed } from './upload-completion';

type UploadSession = components['schemas']['UploadSession'];
type UploadSessionCreate = components['schemas']['UploadSessionCreate'];
type UploadSessionCreated = components['schemas']['UploadSessionCreated'];
type UploadSessionPage = components['schemas']['UploadSessionPage'];
export interface UploadSessionQuery {
  state?: Array<UploadSession['state']>;
  material_id?: string;
  cursor?: string;
  limit?: number;
}
type SessionRow = typeof uploadSessions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** جلسات الرفع: رمز الرفع يظهر في رد الإنشاء فقط ويُحفظ مُجزَّأً (SEC-02)، والبصمة يحسبها الخادم (SEC-06). */
@Injectable()
export class UploadsService implements ReplayRehydrator {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async create(p: Principal, body: UploadSessionCreate): Promise<UploadSessionCreated> {
    if (body.proxy_mode && body.kind !== 'proxy') throw ApiError.validation({ fields: ['/proxy_mode'] });
    // الطاقم يرفع الأصل وحده من الويب؛ النسخة الخفيفة والملاحظة الصوتية من تطبيق المراسل
    if (!hasRole(p, 'reporter') && body.kind !== 'original') throw ApiError.validation({ fields: ['/kind'] });
    // يصير client_sha256 مطلوبًا في عقد v0.1؛ إلى أن يُدمج يفرضه هذا المتغير بالرد نفسه الذي سيعطيه التحقق بالعقد (422)
    if (this.config.UPLOAD_REQUIRE_CLIENT_SHA256 && !body.client_sha256) throw ApiError.validation({ fields: ['/client_sha256'] });
    if (this.config.UPLOAD_MAX_BYTES !== undefined && body.size_bytes > this.config.UPLOAD_MAX_BYTES) {
      throw ApiError.validation({ fields: ['/size_bytes'] });
    }
    return this.db.transaction(async (tx) => {
      const material = await findScoped(tx, p, body.material_id, { forUpdate: true });
      // المنشئ يرفع لمواده فقط (المراسل أو الطاقم)؛ مادة غيره غير موجودة بالنسبة إليه
      if (!material || material.reporterId !== p.userId) throw ApiError.notFound();
      if (body.kind === 'original' && material.technicalState === 'verified') {
        throw new ApiError(409, 'upload_state_conflict', 'The original of this material is already verified.');
      }
      const token = randomToken();
      const [session] = await tx
        .insert(uploadSessions)
        .values({
          materialId: material.id,
          createdBy: p.userId,
          kind: body.kind,
          sizeBytes: body.size_bytes,
          filename: body.filename,
          mimeType: body.mime_type ?? null,
          proxyMode: body.proxy_mode ?? null,
          partSizeBytes: this.config.TUSD_PART_SIZE_BYTES,
          uploadPath: this.config.UPLOAD_PATH,
          clientSha256: body.client_sha256 ? Buffer.from(body.client_sha256, 'hex') : null,
          clientFingerprint: body.client_fingerprint ?? null,
          uploadTokenHash: sha256(token),
          expiresAt: sql`now() + make_interval(secs => ${this.config.UPLOAD_SESSION_TTL_SECONDS})` as never,
          uploadTokenExpiresAt: this.tokenExpiry(sql`now() + make_interval(secs => ${this.config.UPLOAD_SESSION_TTL_SECONDS})`),
        })
        .returning();
      await writeOutboxEvent(tx, {
        type: 'upload.started',
        aggregateType: 'upload',
        aggregateId: session!.id,
        idempotencyKey: `upload.started:${session!.id}`,
        actorId: p.userId,
        payload: { material_id: material.id, upload_session_id: session!.id, kind: body.kind, priority: material.priority },
      });
      return { ...this.toDto(session!, null), upload_token: token, upload_token_expires_at: iso(session!.uploadTokenExpiresAt)! };
    });
  }

  /**
   * جلسات المستدعي وحده، الأحدث أولًا بالمؤشر (created_at، id)، للاستئناف بعد إغلاق التبويب أو التطبيق. الافتراضي غير
   * النهائية. لا رمز رفع في أي قراءة.
   */
  async list(p: Principal, q: UploadSessionQuery): Promise<UploadSessionPage> {
    const limit = q.limit ?? 50;
    const states = q.state?.length ? q.state : ['created', 'in_progress', 'completed'];
    const where: SQL[] = [eq(uploadSessions.createdBy, p.userId), inArray(uploadSessions.state, states)];
    if (q.material_id) where.push(eq(uploadSessions.materialId, q.material_id));
    if (q.cursor) {
      const c = decodeCursor(q.cursor);
      where.push(sql`(${uploadSessions.createdAt}, ${uploadSessions.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await this.db
      .select()
      .from(uploadSessions)
      .where(and(...where))
      .orderBy(desc(uploadSessions.createdAt), desc(uploadSessions.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const fileIds = page.map((s) => s.fileId).filter((f): f is string => Boolean(f));
    const receipts = new Map(
      fileIds.length === 0
        ? []
        : (
            await this.db
              .select({ id: materialFiles.id, r: materialFiles.receiptNumber })
              .from(materialFiles)
              .where(inArray(materialFiles.id, fileIds))
          ).map((f) => [f.id, f.r]),
    );
    const last = page[page.length - 1];
    return {
      items: page.map((s) => this.toDto(s, (s.fileId && receipts.get(s.fileId)) ?? null)),
      // القيمة الخام من القاعدة بدقتها الكاملة (ميكروثانية)، فلا تتخطى الصفحة التالية جلسات في الملّي‌ثانية نفسها
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null,
    };
  }

  /**
   * يلغيها صاحبها وحده: `failed` بسبب `aborted`، ويُبطَل رمز الرفع (ورموز ingest، لأن البوابة تسأل عن حالة الجلسة)،
   * و`upload.failed` في المعاملة نفسها. الأصل المكتمل قبل التحقق يعيد المسار الفني إلى failed. ما وصل يُحذف من التخزين
   * المؤقت بعد الحفظ، وفشل الحذف لا يُفشل الإلغاء (يُسجَّل، وما بقي لقاعدة دورة حياة الحاوية). المكتمل تحققه 409.
   * جلسة منتهية بفشل سابق (ومنها الملغاة) تعيد 204 بلا أثر.
   */
  async abort(p: Principal, id: string): Promise<void> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const key = await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, id)).for('update');
      if (!session || session.createdBy !== p.userId) throw ApiError.notFound();
      if (session.state === 'failed') return null;
      if (session.state === 'verified' || session.state === 'deduplicated') {
        throw new ApiError(409, 'upload_state_conflict', 'A verified upload cannot be cancelled.');
      }
      await tx.update(uploadSessions).set({ uploadTokenHash: null, uploadTokenExpiresAt: null }).where(eq(uploadSessions.id, session.id));
      await markUploadFailed(tx, session, 'aborted');
      await failCompletedOriginal(tx, session, 'original upload cancelled by its owner');
      return session.storageKey ?? `${this.config.TUSD_OBJECT_PREFIX}${session.id}`;
    });
    if (!key || !this.storage.removeUpload) return;
    try {
      await this.storage.removeUpload(this.config.S3_BUCKET_UPLOADS, key);
      // تأكيد الحذف؛ ما لم يُؤكَّد تعيد مكنسة التسوية محاولته (retryRemovals)
      await this.db.update(uploadSessions).set({ storageRemovedAt: sql`now()` }).where(eq(uploadSessions.id, id));
    } catch (err) {
      this.logger.warn({ upload_session_id: id, error: (err as Error).name }, 'cancelled upload not removed from temporary storage');
    }
  }

  async get(p: Principal, id: string): Promise<UploadSession> {
    const session = await this.visible(p, id);
    return this.toDto(session, await this.receiptOf(session));
  }

  /**
   * إعلان الاكتمال في مسار الرفع المباشر فقط؛ في مسار tusd يصل الاكتمال من الخطّاف. لا يُقبل من العميل مفتاح
   * تخزين ولا بصمة تُحفظ: المفتاح مشتق من الجلسة، والتحقق (الحجم وSHA-256) يجريه المُتحقق من التخزين.
   */
  async complete(p: Principal, id: string, reportedSha256: string | null | undefined): Promise<void> {
    if (!UUID.test(id)) throw ApiError.notFound();
    await this.db.transaction(async (tx) => {
      const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, id)).for('update');
      if (!session || session.createdBy !== p.userId) throw ApiError.notFound();
      if (['completed', 'verified', 'deduplicated'].includes(session.state)) return;
      if (session.uploadPath !== 'direct') {
        throw new ApiError(409, 'upload_state_conflict', 'Completion arrives from the upload server for this session.');
      }
      if (session.state === 'failed' || new Date(session.expiresAt) <= new Date() || !session.uploadTokenHash) {
        throw new ApiError(409, 'upload_state_conflict', 'This upload session can no longer be completed.');
      }
      // البصمة المبلَّغ عنها تُقارن ببصمة الإنشاء إن وُجدت؛ اختلافهما لا يحتاج قراءة التخزين ليُرفض
      if (reportedSha256 && session.clientSha256 && !session.clientSha256.equals(Buffer.from(reportedSha256, 'hex'))) {
        throw new ApiError(422, 'checksum_mismatch', 'Reported checksum differs from the one declared at creation.');
      }
      await tx
        .update(uploadSessions)
        .set({ state: 'completed', storageKey: `${this.config.TUSD_OBJECT_PREFIX}${session.id}`, hookReservedUntil: null })
        .where(eq(uploadSessions.id, session.id));
      await writeOutboxEvent(tx, {
        type: session.kind === 'proxy' ? 'upload.proxy_received' : 'upload.original_received',
        aggregateType: 'upload',
        aggregateId: session.id,
        idempotencyKey: `${session.kind === 'proxy' ? 'upload.proxy_received' : 'upload.original_received'}:${session.id}`,
        actorId: p.userId,
        payload: { material_id: session.materialId, upload_session_id: session.id, kind: session.kind },
      });
    });
  }

  /**
   * إعادة POST /uploads بالمفتاح نفسه: الرد المحفوظ بلا رمز، فيُصدر رمز جديد للجلسة نفسها ويبطل السابق. ما دامت
   * `created` فقط، لأن الرمز لا يُقبل بعدها (tusd-hooks.service.ts).
   */
  async rehydrate(stored: unknown, req: Request): Promise<unknown> {
    const body = stored as UploadSession;
    const token = randomToken();
    const [session] = await this.db
      .update(uploadSessions)
      .set({ uploadTokenHash: sha256(token), uploadTokenExpiresAt: this.tokenExpiry(uploadSessions.expiresAt) })
      .where(sql`${uploadSessions.id} = ${body.id} AND ${uploadSessions.createdBy} = ${req.auth!.userId}
        AND ${uploadSessions.state} = 'created'`)
      .returning();
    if (!session) throw new ApiError(409, 'upload_state_conflict', 'This upload session no longer accepts uploads.');
    return { ...this.toDto(session, null), upload_token: token, upload_token_expires_at: iso(session.uploadTokenExpiresAt)! };
  }

  /** انتهاء رمز الرفع: بعد UPLOAD_TOKEN_TTL_SECONDS ولا يتجاوز انتهاء الجلسة (قيد upload_sessions_token_expiry_within_session). */
  private tokenExpiry(sessionExpiry: SQL | typeof uploadSessions.expiresAt): never {
    return sql`least(now() + make_interval(secs => ${this.config.UPLOAD_TOKEN_TTL_SECONDS}), ${sessionExpiry})` as never;
  }

  private async visible(p: Principal, id: string): Promise<SessionRow> {
    if (!UUID.test(id)) throw ApiError.notFound();
    const [session] = await this.db.select().from(uploadSessions).where(eq(uploadSessions.id, id));
    // النطاق نفسه للمادة: المراسل جلساته، والمشرف جلسات نطاقه، ورئيس التحرير ومدير النظام الكل
    if (!session || !(await findScoped(this.db, p, session.materialId))) throw ApiError.notFound();
    return session;
  }

  private async receiptOf(session: SessionRow): Promise<string | null> {
    if (!session.fileId) return null;
    const [file] = await this.db.select({ r: materialFiles.receiptNumber }).from(materialFiles).where(eq(materialFiles.id, session.fileId));
    return file?.r ?? null;
  }

  private toDto(s: SessionRow, receipt: string | null): UploadSession {
    // SEC-07: الخادم وحده يقرر نطاق ingest (لا تبديل آلي في العميل)، لمسار tus فقط. القرار بالإعداد لا لكل جلسة: لا عمود
    // له في v0.1، فتبديله أثناء رفع جارٍ ينقل استئنافه إلى النطاق الآخر (يُضبط قبل فتح الجلسات لا أثناءها).
    const ingest = this.config.INGEST_REQUIRED && s.uploadPath === 'tusd';
    return {
      id: s.id,
      material_id: s.materialId,
      kind: s.kind as UploadSession['kind'],
      state: s.state as UploadSession['state'],
      size_bytes: Number(s.sizeBytes),
      tus_endpoint: ingest ? this.config.INGEST_TUS_ENDPOINT! : this.config.TUS_PUBLIC_ENDPOINT,
      ingest_token_required: ingest,
      tus_metadata: { upload_session_id: s.id, filename: s.filename },
      part_size_bytes: s.partSizeBytes,
      bytes_received: Number(s.bytesReceived),
      ietf_resumable: false,
      checksum_algorithm: 'sha256',
      expires_at: iso(s.expiresAt)!,
      file_id: s.fileId,
      duplicate_of_file_id: s.duplicateOfFileId,
      failure_reason: s.failureReason as UploadSession['failure_reason'],
      receipt_number: receipt,
      created_at: iso(s.createdAt)!,
      updated_at: iso(s.updatedAt),
    };
  }
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof at === 'string' && validTimestamp(at) && typeof id === 'string' && UUID.test(id)) return { at, id };
  } catch {
    // يقع إلى 400 أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}

/**
 * الطابع كما تعيده القاعدة (`2026-10-21 23:00:00.123456+00`) أو ISO، بحقول ضمن مداها؛ فما يمر هنا يقبله `::timestamptz`
 * ولا يصير 500. Date.parse وحده يقبل صيغًا يرفضها Postgres.
 */
export function validTimestamp(at: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(at);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d && h < 24 && mi < 60 && sec < 60;
}
