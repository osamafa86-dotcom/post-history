import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor, Tx } from '../database/database.module';
import { catalogListings, materialFiles } from '../database/schema/schema';
import { writeOutboxEvent } from '../outbox/outbox';

type ListingRow = typeof catalogListings.$inferSelect;

/** الأصل المتحقق منه للمادة: مصدر معاينة المشتري التي يبنيها عامل الوسائط من الحدث. */
export async function sourceFileId(executor: Executor, materialId: string): Promise<string | null> {
  const [file] = await executor
    .select({ id: materialFiles.id })
    .from(materialFiles)
    .where(and(eq(materialFiles.materialId, materialId), eq(materialFiles.kind, 'original'), eq(materialFiles.state, 'verified')))
    .orderBy(desc(materialFiles.verifiedAt))
    .limit(1);
  return file?.id ?? null;
}

/**
 * `catalog.listing_changed` في معاملة التغيير نفسها، بالمعرّفات والحالة وحدها (لا عنوان ولا سعر). مفتاح التكرار بوقت
 * التحديث بدقة القاعدة، فكل تغيير حدث واحد.
 */
export async function writeListingEvent(tx: Tx, listing: ListingRow, actorId: string | null): Promise<void> {
  const [{ at }] = (await tx.execute<{ at: string }>(sql`SELECT (extract(epoch FROM ${listing.updatedAt}::timestamptz) * 1000000)::bigint::text AS at`)).rows as [{ at: string }];
  await writeOutboxEvent(tx, {
    type: 'catalog.listing_changed',
    aggregateType: 'listing',
    aggregateId: listing.id,
    idempotencyKey: `catalog.listing_changed:${listing.id}:${at}`,
    actorId,
    payload: {
      listing_id: listing.id,
      material_id: listing.materialId,
      material_version: listing.materialVersion,
      source_file_id: await sourceFileId(tx, listing.materialId),
      state: listing.state,
      suspended_reason: listing.suspendedReason,
    },
  });
}

/**
 * الحقوق تخرج من `sellable` والإدراج معروض: يُعلَّق أولًا (`rights_changed`) في معاملة الانتقال نفسها، لأن محفّز القاعدة
 * يرفض الانتقال ما دام معروضًا. لا يعود `listed` إلا بطلب صريح.
 */
export async function suspendListingForRights(tx: Tx, materialId: string, actorId: string | null): Promise<void> {
  const [suspended] = await tx
    .update(catalogListings)
    .set({ state: 'suspended', suspendedReason: 'rights_changed', updatedBy: sql`COALESCE(${actorId}::uuid, ${catalogListings.updatedBy})` as never })
    .where(and(eq(catalogListings.materialId, materialId), eq(catalogListings.state, 'listed')))
    .returning();
  if (suspended) await writeListingEvent(tx, suspended, actorId);
}
