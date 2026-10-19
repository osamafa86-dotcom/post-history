import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { sha256 } from '../common/crypto';
import { ApiError } from '../common/errors';
import { DB, type Database } from '../database/database.module';
import { uploadSessions } from '../database/schema/schema';
import type { components } from '../generated/api';
import { applyTransition, lockMaterial, technicalTargetOnReceive } from '../materials/material-store';
import { writeOutboxEvent, type OutboxEventType } from '../outbox/outbox';

export type TusdHookRequest = components['schemas']['TusdHookRequest'];
export type TusdHookResponse = components['schemas']['TusdHookResponse'];

const REJECT: TusdHookResponse = {
  RejectUpload: true,
  HTTPResponse: { StatusCode: 403, Body: 'upload rejected' },
};

const ACCEPT: TusdHookResponse = { RejectUpload: false };

const RECEIVED_EVENT: Record<string, OutboxEventType> = {
  original: 'upload.original_received',
  proxy: 'upload.proxy_received',
  voice_note: 'upload.original_received',
};

/** خطّافات tusd (ADR SEC-06). الخادم لا يثق بشيء من الخطّاف إلا ما يطابق جلسة الرفع المحفوظة. */
@Injectable()
export class TusdHooksService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** مفتاح الكائن الذي تتوقعه الجلسة؛ يُثبَّت في pre-create عبر ChangeFileInfo.ID ويُطابَق في post-finish. */
  expectedStorageKey(sessionId: string): string {
    return `${this.config.TUSD_OBJECT_PREFIX}${sessionId}`;
  }

  async handle(hook: TusdHookRequest): Promise<TusdHookResponse> {
    switch (hook.Type) {
      case 'pre-create':
        return this.preCreate(hook);
      case 'post-finish':
        return this.postFinish(hook);
      default:
        return ACCEPT;
    }
  }

  private async preCreate(hook: TusdHookRequest): Promise<TusdHookResponse> {
    const sessionId = hook.Event.Upload.MetaData.upload_session_id;
    const token = bearerToken(hook.Event.HTTPRequest.Header);
    if (!token) return REJECT;

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId))
        .for('update');
      if (
        !session ||
        !session.uploadTokenHash ||
        !timingSafeEqual(session.uploadTokenHash, sha256(token)) ||
        // الرمز يفتح إنشاء رفع واحد: بعد قبوله تصبح الجلسة in_progress فلا يُقبل ثانية (الاستئناف عبر PATCH لا يمر
        // بهذا الخطّاف). إلى أن يفصل العقد عمر الرمز عن عمر الجلسة، هذا ما يحد من رمز مسرّب.
        session.state !== 'created' ||
        new Date(session.expiresAt) <= new Date() ||
        Number(session.sizeBytes) !== hook.Event.Upload.Size
      ) {
        return REJECT;
      }
      const storageKey = this.expectedStorageKey(session.id);
      await tx
        .update(uploadSessions)
        .set({ state: 'in_progress', storageKey })
        .where(eq(uploadSessions.id, session.id));
      return { RejectUpload: false, ChangeFileInfo: { ID: session.id } };
    });
  }

  private async postFinish(hook: TusdHookRequest): Promise<TusdHookResponse> {
    const sessionId = hook.Event.Upload.MetaData.upload_session_id;
    const storage = hook.Event.Upload.Storage;

    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(eq(uploadSessions.id, sessionId))
        .for('update');
      if (!session) throw ApiError.notFound();
      // tusd يعيد المحاولة: ما سُجّل اكتماله أو فشله سابقًا يعيد 200 نفسها دون أثر جديد
      if (!['created', 'in_progress'].includes(session.state)) return ACCEPT;

      const expectedKey = session.storageKey ?? this.expectedStorageKey(session.id);
      const keyMatches = storage?.Key === expectedKey;
      const bucketMatches = storage?.Bucket === undefined || storage.Bucket === this.config.S3_BUCKET_UPLOADS;
      const base = { material_id: session.materialId, upload_session_id: session.id, kind: session.kind };

      if (!keyMatches || !bucketMatches) {
        await tx
          .update(uploadSessions)
          .set({ state: 'failed', failureReason: 'storage_error' })
          .where(eq(uploadSessions.id, session.id));
        await writeOutboxEvent(tx, {
          type: 'upload.failed',
          aggregateType: 'upload',
          aggregateId: session.id,
          idempotencyKey: `upload.failed:${session.id}`,
          payload: { ...base, failure_reason: 'storage_error' },
        });
        return ACCEPT;
      }

      // الحجم الفعلي وSHA-256 يحسبهما عامل الوسائط من التخزين بعد التجميع (لا يُحفظ شيء من الخطّاف)،
      // ثم ينقل الجلسة إلى verified/failed(checksum_mismatch) وينشئ material_files. هنا: الاكتمال فقط.
      await tx
        .update(uploadSessions)
        .set({ state: 'completed', storageKey: expectedKey, tusUploadId: hook.Event.Upload.ID ?? sql`tus_upload_id` })
        .where(eq(uploadSessions.id, session.id));
      // المسار الفني للمادة يكتبه الخادم وحده: pending → proxy_received → original_received
      const material = await lockMaterial(tx, session.materialId);
      const target = material && technicalTargetOnReceive(session.kind, material.technicalState);
      if (material && target) {
        await applyTransition(tx, material, { track: 'technical', to: target, reason: `${session.kind} upload received`, actorId: null });
      }
      const type = RECEIVED_EVENT[session.kind]!;
      await writeOutboxEvent(tx, {
        type,
        aggregateType: 'upload',
        aggregateId: session.id,
        idempotencyKey: `${type}:${session.id}`,
        payload: base,
      });
      return ACCEPT;
    });
  }
}

function bearerToken(headers: Record<string, string[]> | undefined): string | undefined {
  if (!headers) return undefined;
  const name = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
  const value = name ? headers[name]?.[0] : undefined;
  const match = value ? /^Bearer ([^\s]+)$/.exec(value) : null;
  return match?.[1];
}
