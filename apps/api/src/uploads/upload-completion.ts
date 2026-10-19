import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { uploadSessions } from '../database/schema/schema';
import { applyTransition, lockMaterial, technicalTargetOnReceive } from '../materials/material-store';
import { writeOutboxEvent, type OutboxEventType } from '../outbox/outbox';

type SessionRow = typeof uploadSessions.$inferSelect;
type FailureReason = 'storage_error' | 'expired' | 'aborted';

const RECEIVED_EVENT: Record<string, OutboxEventType> = {
  original: 'upload.original_received',
  proxy: 'upload.proxy_received',
  voice_note: 'upload.original_received',
};

/**
 * وصل الملف كاملًا إلى التخزين: الجلسة (مقفولة في المعاملة) تصير completed ويتقدم المسار الفني وحدث الاستلام في
 * Outbox. يستدعيها post-finish ومكنسة التسوية (حين ضاع post-finish). الحجم والبصمة يتحقق منهما المُتحقق بعدها.
 */
export async function markReceived(tx: Tx, session: SessionRow, storageKey: string, tusUploadId?: string): Promise<void> {
  await tx
    .update(uploadSessions)
    .set({ state: 'completed', storageKey, tusUploadId: tusUploadId ?? sql`tus_upload_id`, hookReservedUntil: null })
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
    payload: { material_id: session.materialId, upload_session_id: session.id, kind: session.kind },
  });
}

/** فشل الرفع قبل التحقق (مفتاح تخزين غريب، أو انتهاء الجلسة دون أن يصل الملف). */
export async function markUploadFailed(tx: Tx, session: SessionRow, reason: FailureReason): Promise<void> {
  await tx
    .update(uploadSessions)
    .set({ state: 'failed', failureReason: reason, hookReservedUntil: null })
    .where(eq(uploadSessions.id, session.id));
  await writeOutboxEvent(tx, {
    type: 'upload.failed',
    aggregateType: 'upload',
    aggregateId: session.id,
    idempotencyKey: `upload.failed:${session.id}`,
    payload: { material_id: session.materialId, upload_session_id: session.id, kind: session.kind, failure_reason: reason },
  });
}
