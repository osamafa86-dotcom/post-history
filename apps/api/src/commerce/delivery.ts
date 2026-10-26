import { and, desc, eq } from 'drizzle-orm';
import { ApiError } from '../common/errors';
import type { Tx } from '../database/database.module';
import { materialFiles } from '../database/schema/schema';
import type { components } from '../generated/api';
import { writeOutboxEvent } from '../outbox/outbox';

type Deliverable = components['schemas']['LicenseTemplateInput']['deliverables'][number];
const DELIVERABLES: ReadonlySet<string> = new Set<Deliverable>(['original', 'produced', 'audio', 'stills']);

/**
 * أنواع الملف التي تصلح نسخةً منتَجة في حزمة المشتري (ADR 0025 الجزء 9، R11). العامل يضمّن الملف كما هو بلا نزع، فلا
 * يدخل التفريغ ولا الترجمة ولا قائمة اللقطات ولا حزمة التصدير التحريرية ولا أي مشتق آخر. لا نوع في العقد اليوم للنسخة
 * المنتَجة النهائية (لا محرر بعد)، فالقائمة فارغة: كل `produced_file_id` يُرفض بـ 422 حتى يعرّف العقد نوعها فيُضاف هنا.
 */
export const PRODUCED_KINDS: ReadonlySet<string> = new Set<string>();

export interface DeliveryRequest {
  licenseId: string;
  materialId: string;
  deliverables: readonly string[];
  producedFileId?: string | null;
  actorId: string | null;
}

/**
 * طلب بناء حزمة تسليم ترخيص: يكتب `license.delivery_requested` في معاملة الترخيص نفسها بالمعرّفات ومواصفات التسليم
 * وحدها، من آخر أصل متحقق للمادة. يرفض قبل الحدث (422) بنود التسليم غير المعروفة أو المكررة، و`produced_file_id` إن لم
 * يكن ملفًا متحققًا من المادة نفسها من نوع في `PRODUCED_KINDS`، أو غاب و`produced` مطلوب، أو وُجد بلا `produced`.
 */
export async function requestDelivery(tx: Tx, req: DeliveryRequest): Promise<{ sourceFileId: string }> {
  const fields: string[] = [];
  if (req.deliverables.length === 0 || new Set(req.deliverables).size !== req.deliverables.length || req.deliverables.some((d) => !DELIVERABLES.has(d))) {
    fields.push('/deliverables');
  }
  const wantsProduced = req.deliverables.includes('produced');
  const producedFileId = req.producedFileId ?? null;
  if (wantsProduced !== (producedFileId !== null)) fields.push('/produced_file_id');
  else if (producedFileId !== null && !(await isProducedFile(tx, req.materialId, producedFileId))) fields.push('/produced_file_id');
  if (fields.length > 0) throw ApiError.validation({ fields });

  const [source] = await tx
    .select({ id: materialFiles.id })
    .from(materialFiles)
    .where(and(eq(materialFiles.materialId, req.materialId), eq(materialFiles.kind, 'original'), eq(materialFiles.state, 'verified')))
    .orderBy(desc(materialFiles.verifiedAt), desc(materialFiles.id))
    .limit(1);
  if (!source) throw new ApiError(409, 'upload_state_conflict', 'The material has no verified original to deliver.');

  await writeOutboxEvent(tx, {
    type: 'license.delivery_requested',
    aggregateType: 'license',
    aggregateId: req.licenseId,
    idempotencyKey: `license.delivery_requested:${req.licenseId}:${source.id}`,
    actorId: req.actorId,
    payload: {
      license_id: req.licenseId,
      material_id: req.materialId,
      source_file_id: source.id,
      deliverables: [...req.deliverables],
      produced_file_id: producedFileId,
    },
  });
  return { sourceFileId: source.id };
}

async function isProducedFile(tx: Tx, materialId: string, fileId: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) return false;
  const [f] = await tx
    .select({ kind: materialFiles.kind, state: materialFiles.state, materialId: materialFiles.materialId })
    .from(materialFiles)
    .where(eq(materialFiles.id, fileId));
  return !!f && f.materialId === materialId && f.state === 'verified' && PRODUCED_KINDS.has(f.kind);
}
