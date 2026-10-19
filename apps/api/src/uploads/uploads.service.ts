import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { randomToken, sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { materialFiles, uploadSessions } from '../database/schema/schema';
import type { components } from '../generated/api';
import type { Principal } from '../identity/principal';
import type { ReplayRehydrator } from '../idempotency/replay';
import { findScoped, iso } from '../materials/material-store';
import { writeOutboxEvent } from '../outbox/outbox';

type UploadSession = components['schemas']['UploadSession'];
type UploadSessionCreate = components['schemas']['UploadSessionCreate'];
type UploadSessionCreated = components['schemas']['UploadSessionCreated'];
type SessionRow = typeof uploadSessions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** جلسات الرفع: رمز الرفع يظهر في رد الإنشاء فقط ويُحفظ مُجزَّأً (SEC-02)، والبصمة يحسبها الخادم (SEC-06). */
@Injectable()
export class UploadsService implements ReplayRehydrator {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(p: Principal, body: UploadSessionCreate): Promise<UploadSessionCreated> {
    if (body.proxy_mode && body.kind !== 'proxy') throw ApiError.validation({ fields: ['/proxy_mode'] });
    return this.db.transaction(async (tx) => {
      const material = await findScoped(tx, p, body.material_id, { forUpdate: true });
      // المراسل يرفع لمواده فقط؛ مادة غيره غير موجودة بالنسبة إليه
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
      return { ...this.toDto(session!, null), upload_token: token, upload_token_expires_at: iso(session!.expiresAt)! };
    });
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
      if (session.state === 'failed' || new Date(session.expiresAt) <= new Date()) {
        throw new ApiError(409, 'upload_state_conflict', 'This upload session can no longer be completed.');
      }
      // البصمة المبلَّغ عنها تُقارن ببصمة الإنشاء إن وُجدت؛ اختلافهما لا يحتاج قراءة التخزين ليُرفض
      if (reportedSha256 && session.clientSha256 && !session.clientSha256.equals(Buffer.from(reportedSha256, 'hex'))) {
        throw new ApiError(422, 'checksum_mismatch', 'Reported checksum differs from the one declared at creation.');
      }
      await tx
        .update(uploadSessions)
        .set({ state: 'completed', storageKey: `${this.config.TUSD_OBJECT_PREFIX}${session.id}` })
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

  /** إعادة POST /uploads بالمفتاح نفسه: الرد المحفوظ بلا رمز، فيُصدر رمز جديد للجلسة نفسها ويبطل السابق. */
  async rehydrate(stored: unknown, req: Request): Promise<unknown> {
    const body = stored as UploadSession;
    const token = randomToken();
    const [session] = await this.db
      .update(uploadSessions)
      .set({ uploadTokenHash: sha256(token) })
      .where(sql`${uploadSessions.id} = ${body.id} AND ${uploadSessions.createdBy} = ${req.auth!.userId}
        AND ${uploadSessions.state} IN ('created', 'in_progress')`)
      .returning();
    if (!session) throw new ApiError(409, 'upload_state_conflict', 'This upload session no longer accepts uploads.');
    return { ...this.toDto(session, null), upload_token: token, upload_token_expires_at: iso(session.expiresAt)! };
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
    return {
      id: s.id,
      material_id: s.materialId,
      kind: s.kind as UploadSession['kind'],
      state: s.state as UploadSession['state'],
      size_bytes: Number(s.sizeBytes),
      tus_endpoint: this.config.TUS_PUBLIC_ENDPOINT,
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
