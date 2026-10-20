import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { auditLog, uploadSessions, users } from '../database/schema/schema';
import { applyTransition, lockMaterial, technicalTargetOnReceive } from '../materials/material-store';
import { transitionOwners } from '../materials/transitions';
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

/**
 * هل سُحب وصول صاحب الجلسة؟ رمز الرفع مُصفَّر (revokeAllAccess: خروج من كل الأجهزة، فقد هاتف، اعتماد استعادة،
 * تعليق) أو الحساب غير فاعل. الرمز لا يُصفَّر في غير ذلك ما دامت الجلسة حية، فغيابه علامة الإبطال.
 */
export async function uploadAccessRevoked(tx: Tx, session: SessionRow): Promise<boolean> {
  if (!session.uploadTokenHash) return true;
  const [owner] = await tx.select({ status: users.status }).from(users).where(eq(users.id, session.createdBy));
  return owner?.status !== 'active';
}

/**
 * جلسة رفع حية لصاحب أُبطل وصوله لا تكتمل: تفشل بسبب `aborted` (ضمن قيم العقد) بلا إيصال ولا حدث استلام أو تحقق،
 * ويُسجَّل ذلك في التدقيق بمعرّفات فقط. upload.failed يُكتب كأي فشل فيعرف العميل أن الرفع لم يُقبل.
 */
export async function abortRevokedUpload(tx: Tx, session: SessionRow): Promise<void> {
  await markUploadFailed(tx, session, 'aborted');
  // أصل اكتمل وتقدّم به المسار الفني ثم أُلغي قبل التحقق: المادة تعود failed كفشل التحقق (والمراسل يعيدها pending)
  if (session.state === 'completed' && session.kind === 'original') {
    const material = await lockMaterial(tx, session.materialId);
    if (material && transitionOwners('technical', material.technicalState, 'failed')) {
      await applyTransition(tx, material, { track: 'technical', to: 'failed', reason: 'original aborted: access revoked', actorId: null });
    }
  }
  await tx.insert(auditLog).values({
    actorId: null,
    action: 'upload.aborted_access_revoked',
    targetType: 'upload_session',
    targetId: session.id,
    details: { upload_session_id: session.id, material_id: session.materialId, target_user_id: session.createdBy, reason_code: 'access_revoked' },
    hash: Buffer.alloc(32),
  });
}
