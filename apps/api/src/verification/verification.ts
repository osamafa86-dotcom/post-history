import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { materialFiles, uploadSessions } from '../database/schema/schema';
import { applyTransition, lockMaterial } from '../materials/material-store';
import { transitionOwners } from '../materials/transitions';
import { writeOutboxEvent } from '../outbox/outbox';
import type { ObjectStorage } from './object-storage';

export type UploadSessionRow = typeof uploadSessions.$inferSelect;

export type VerificationOutcome =
  | { result: 'verified'; sha256: Buffer; sizeBytes: number }
  | { result: 'failed'; reason: 'checksum_mismatch' | 'invalid_file' | 'storage_error' };

/**
 * يقرأ الكائن من التخزين تدفقيًا ويحسب SHA-256 على الخادم (لا يثق بأي بصمة من العميل أو الخطّاف، ADR SEC-06).
 * الحجم يُقرأ من التخزين؛ اختلافه عن حجم الجلسة ملف غير صالح. بصمة العميل، إن وُجدت، تُقارن فقط.
 */
export async function inspectUpload(storage: ObjectStorage, bucket: string, session: UploadSessionRow): Promise<VerificationOutcome> {
  if (!session.storageKey) return { result: 'failed', reason: 'storage_error' };
  const head = await storage.head(bucket, session.storageKey);
  if (!head) return { result: 'failed', reason: 'storage_error' };
  if (head.size !== Number(session.sizeBytes)) return { result: 'failed', reason: 'invalid_file' };

  const hash = createHash('sha256');
  let read = 0;
  for await (const chunk of await storage.read(bucket, session.storageKey)) {
    hash.update(chunk as Buffer);
    read += (chunk as Buffer).length;
  }
  if (read !== head.size) return { result: 'failed', reason: 'invalid_file' };
  const sha256 = hash.digest();
  if (session.clientSha256 && !session.clientSha256.equals(sha256)) return { result: 'failed', reason: 'checksum_mismatch' };
  return { result: 'verified', sha256, sizeBytes: read };
}

/**
 * يطبّق نتيجة التحقق على جلسة `completed` مقفولة داخل المعاملة. هذه هي الواجهة التي يستدعيها أي مُتحقق
 * (الخادم الآن، عامل الوسائط لاحقًا): ملف المادة، رقم الإيصال (محفّز القاعدة عند تحقق الأصل)، حالة الجلسة،
 * المسار الفني للمادة، وحدث upload.verified أو upload.failed.
 */
export async function recordVerification(tx: Tx, session: UploadSessionRow, outcome: VerificationOutcome): Promise<void> {
  const base = { material_id: session.materialId, upload_session_id: session.id, kind: session.kind };
  const material = await lockMaterial(tx, session.materialId);

  if (outcome.result === 'failed') {
    await tx
      .update(uploadSessions)
      .set({ state: 'failed', failureReason: outcome.reason })
      .where(eq(uploadSessions.id, session.id));
    await writeOutboxEvent(tx, {
      type: 'upload.failed',
      aggregateType: 'upload',
      aggregateId: session.id,
      idempotencyKey: `upload.failed:${session.id}`,
      payload: { ...base, failure_reason: outcome.reason },
    });
    if (session.kind === 'original' && material && transitionOwners('technical', material.technicalState, 'failed')) {
      await applyTransition(tx, material, { track: 'technical', to: 'failed', reason: `original ${outcome.reason}`, actorId: null });
    }
    return;
  }

  // الأصل لا يُمس: ملف جديد لكل جلسة. يُدرج received ثم يُرقّى إلى verified ليسند المحفّز رقم الإيصال.
  const [file] = await tx
    .insert(materialFiles)
    .values({
      materialId: session.materialId,
      kind: session.kind,
      state: 'received',
      uploadSessionId: session.id,
      storageKey: session.storageKey,
      sizeBytes: outcome.sizeBytes,
      mimeType: session.mimeType,
      proxyMode: session.proxyMode,
    })
    .returning({ id: materialFiles.id });
  const [verified] = await tx
    .update(materialFiles)
    .set({ state: 'verified', sha256: outcome.sha256, verifiedAt: sql`now()` })
    .where(eq(materialFiles.id, file!.id))
    .returning({ receiptNumber: materialFiles.receiptNumber });
  await tx
    .update(uploadSessions)
    .set({ state: 'verified', fileId: file!.id, bytesReceived: outcome.sizeBytes })
    .where(eq(uploadSessions.id, session.id));
  await writeOutboxEvent(tx, {
    type: 'upload.verified',
    aggregateType: 'upload',
    aggregateId: session.id,
    idempotencyKey: `upload.verified:${session.id}`,
    payload: { ...base, file_id: file!.id, ...(verified?.receiptNumber ? { receipt_number: verified.receiptNumber } : {}) },
  });
  if (session.kind === 'original' && material && transitionOwners('technical', material.technicalState, 'verified')) {
    await applyTransition(tx, material, { track: 'technical', to: 'verified', reason: 'original checksum verified', actorId: null });
  }
}
