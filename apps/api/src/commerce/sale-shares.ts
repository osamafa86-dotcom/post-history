import { eq } from 'drizzle-orm';
import type { Tx } from '../database/database.module';
import { materialContributors, materials } from '../database/schema/schema';
import { allocate, type Currency, money, percentToBasisPoints } from './money';

/**
 * حصص بند واحد من البيعة (ADR 0031): ما للمنصة وما لكل مساهم من سعره بالعمولة المجمّدة له. تُكتب في تفاصيل قيد البيعة
 * (`item_shares`)، فيعكس استرداد البند حصصه هو، لا نسبةً من قيد الطلب كله.
 */
export interface ItemShares {
  orderItemId: string;
  platform: bigint;
  contributors: Array<{ userId: string; amount: bigint }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** حصص المساهمين من material_contributors (مجموعها 100.00)، وإلا المراسل وحده. */
export async function contributorShares(tx: Tx, materialId: string): Promise<Array<{ key: string; weight: bigint }>> {
  const rows = await tx.select({ userId: materialContributors.userId, share: materialContributors.sharePercent }).from(materialContributors).where(eq(materialContributors.materialId, materialId));
  if (rows.length > 0) return rows.map((r) => ({ key: r.userId, weight: percentToBasisPoints(String(r.share)) }));
  const [m] = await tx.select({ reporterId: materials.reporterId }).from(materials).where(eq(materials.id, materialId));
  return [{ key: m!.reporterId, weight: 1n }];
}

/** سعر البند مقسومًا بنقاط المنصة ثم بحصص مساهمي مادته؛ المجموع يساوي السعر بالضبط. */
export async function splitItem(tx: Tx, item: { id: string; materialId: string; priceMinor: number | bigint }, currency: Currency, basisPoints: number): Promise<ItemShares> {
  const bp = BigInt(basisPoints);
  const split = allocate(money(item.priceMinor, currency), [
    { key: 'platform', weight: bp },
    { key: 'contributors', weight: 10_000n - bp },
  ]);
  const shares = allocate(split.get('contributors')!, await contributorShares(tx, item.materialId));
  return {
    orderItemId: item.id,
    platform: split.get('platform')!.amountMinor,
    contributors: [...shares].map(([userId, m]) => ({ userId, amount: m.amountMinor })),
  };
}

/** صيغة التفاصيل: معرّفات وأرقام وحدها (قيد ledger_details_is_plain). */
export function itemSharesToDetails(items: readonly ItemShares[]): unknown[] {
  return items.map((i) => ({
    order_item_id: i.orderItemId,
    platform_minor: Number(i.platform),
    contributors: i.contributors.map((c) => ({ user_id: c.userId, amount_minor: Number(c.amount) })),
  }));
}

const amount = (v: unknown): bigint | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

/** حصص البنود من تفاصيل قيد بيعة، أو null إن غابت أو خالفت الصيغة (قيد كُتب قبل تسجيلها). */
export function itemSharesFromDetails(details: unknown): ItemShares[] | null {
  const raw = (details as { item_shares?: unknown } | null)?.item_shares;
  if (!Array.isArray(raw)) return null;
  const out: ItemShares[] = [];
  for (const entry of raw as Array<Record<string, unknown>>) {
    const platform = amount(entry?.platform_minor);
    if (typeof entry?.order_item_id !== 'string' || !UUID.test(entry.order_item_id) || platform === null || !Array.isArray(entry.contributors)) return null;
    const contributors: ItemShares['contributors'] = [];
    for (const c of entry.contributors as Array<Record<string, unknown>>) {
      const share = amount(c?.amount_minor);
      if (typeof c?.user_id !== 'string' || !UUID.test(c.user_id) || share === null) return null;
      contributors.push({ userId: c.user_id, amount: share });
    }
    out.push({ orderItemId: entry.order_item_id, platform, contributors });
  }
  return out;
}

/** مجموع حصص بنود: ما للمنصة، وما لكل مساهم. */
export function totalShares(items: readonly ItemShares[]): { platform: bigint; contributors: Map<string, bigint> } {
  const contributors = new Map<string, bigint>();
  let platform = 0n;
  for (const i of items) {
    platform += i.platform;
    for (const c of i.contributors) contributors.set(c.userId, (contributors.get(c.userId) ?? 0n) + c.amount);
  }
  return { platform, contributors };
}
