import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../database/database.module';
import { journalEntries, materialContributors, materials, orderItems, orders, refundItems } from '../database/schema/schema';
import type { components } from '../generated/api';
import { iso } from '../materials/material-store';
import { type Currency, money, toContract } from './money';
import { itemSharesFromDetails } from './sale-shares';

type EntrySale = NonNullable<components['schemas']['EarningsEntry']['sale']>;
type Line = { id: string; entry_id: string; kind: string; state: string; currency: Currency; reference_type: string; reference_id: string; occurred_at: string };

/**
 * ما يقوله سطر كشف المراسل عن بيعته (قرار المنسّق 2026-11-15): لسطر `sale` و`refund` البنودُ التي له فيها حصة (معرّف المادة وعنوانها ونوع
 * الترخيص وحصته المجمّدة في قيد البيعة، ADR 0031) ولحظةُ البيع، وللسطر المعلّق من بيعة موعدُ تحريره. لا مشترٍ ولا مؤسسة ولا سعر ولا قاعدة.
 * القيد الأقدم بلا حصص البنود: بنود المواد التي هو مساهم فيها، بلا حصة.
 */
export async function statementDetails(executor: Executor, userId: string, releaseAfterDays: number, lines: readonly Line[]): Promise<Map<string, { sale: EntrySale | null; releases_at: string | null }>> {
  const out = new Map<string, { sale: EntrySale | null; releases_at: string | null }>();
  const relevant = lines.filter((l) => (l.kind === 'sale' || l.kind === 'refund') && l.reference_type === 'order');
  for (const l of lines) {
    const at = iso(l.occurred_at)!;
    out.set(l.id, { sale: null, releases_at: l.kind === 'sale' && l.state === 'pending' ? new Date(Date.parse(at) + releaseAfterDays * 86_400_000).toISOString() : null });
  }
  if (relevant.length === 0) return out;
  const orderIds = [...new Set(relevant.map((l) => l.reference_id))];
  const [entries, sales, paid, items] = await Promise.all([
    executor.select({ id: journalEntries.id, details: journalEntries.details }).from(journalEntries).where(inArray(journalEntries.id, [...new Set(relevant.map((l) => l.entry_id))])),
    executor
      .select({ orderId: journalEntries.referenceId, details: journalEntries.details })
      .from(journalEntries)
      .where(and(eq(journalEntries.kind, 'sale'), eq(journalEntries.referenceType, 'order'), inArray(journalEntries.referenceId, orderIds))),
    executor.select({ id: orders.id, paidAt: orders.paidAt }).from(orders).where(inArray(orders.id, orderIds)),
    executor
      .select({ id: orderItems.id, orderId: orderItems.orderId, materialId: orderItems.materialId, licenseType: orderItems.licenseType, title: materials.title, reporterId: materials.reporterId })
      .from(orderItems)
      .innerJoin(materials, eq(materials.id, orderItems.materialId))
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(orderItems.id),
  ]);
  const refundIds = entries.map((e) => (e.details as { refund_id?: unknown } | null)?.refund_id).filter((id): id is string => typeof id === 'string');
  const [refunded, contributors] = await Promise.all([
    refundIds.length ? executor.select().from(refundItems).where(inArray(refundItems.refundId, refundIds)) : Promise.resolve([]),
    executor.select({ materialId: materialContributors.materialId, userId: materialContributors.userId }).from(materialContributors).where(inArray(materialContributors.materialId, [...new Set(items.map((i) => i.materialId))])),
  ]);
  // مساهم في المادة: في جدول المساهمين، وإلا مراسلها (كما في قسمة البيعة)
  const contributes = (i: (typeof items)[number]) => {
    const listed = contributors.filter((c) => c.materialId === i.materialId);
    return listed.length ? listed.some((c) => c.userId === userId) : i.reporterId === userId;
  };
  for (const l of relevant) {
    const shares = itemSharesFromDetails(sales.find((s) => s.orderId === l.reference_id)?.details);
    const refundId = l.kind === 'refund' ? (entries.find((e) => e.id === l.entry_id)?.details as { refund_id?: unknown } | null)?.refund_id : undefined;
    const scope = l.kind === 'refund' ? new Set(refunded.filter((r) => r.refundId === refundId).map((r) => r.orderItemId)) : null;
    const sold = items
      .filter((i) => i.orderId === l.reference_id && (!scope || scope.has(i.id)))
      .flatMap((i) => {
        const share = shares ? shares.find((s) => s.orderItemId === i.id)?.contributors.find((c) => c.userId === userId)?.amount ?? 0n : null;
        if (shares ? !share : !contributes(i)) return [];
        return [{ material_id: i.materialId, title: i.title, license_type: i.licenseType as EntrySale['items'][number]['license_type'], share: share === null ? null : toContract(money(share, l.currency)) }];
      });
    const paidAt = iso(paid.find((o) => o.id === l.reference_id)?.paidAt ?? null);
    if (paidAt) out.set(l.id, { ...out.get(l.id)!, sale: { sold_at: paidAt, items: sold.slice(0, 20) } });
  }
  return out;
}
