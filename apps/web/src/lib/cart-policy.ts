import type { CartItem } from "@/components/store/cart";
import type { CatalogItem, Price } from "./store-format";

// السلة حالة في المتصفح، والكتالوج يتغيّر بعدها: سعر يُعدَّل، وإدراج يُعلَّق، وحصرية تُباع. ما هنا يقابل بند السلة بالكتالوج كما هو الآن
// (S3)، فيرى المشتري ما تغيّر قبل أن يرفضه الخادم عند إنشاء الطلب.

/** ما تغيّر في بند منذ أُضيف: سعر جديد (يُعرض ويُدفع به)، أو لم يعد معروضًا بترخيصه، أو عليه حصرية (بنهايتها إن كانت نشطة). */
export type CartChange = { kind: "price"; from: Price; to: Price } | { kind: "gone" } | { kind: "held"; until: string | null };
/** بند لا يُشترى الآن: يبقى في السلة ظاهرًا حتى يزيله المشتري، ولا يُنشأ به طلب. */
export const blocking = (change: CartChange | null | undefined) => change?.kind === "gone" || change?.kind === "held";

/**
 * بند السلة مقابل إدراجه الآن (`null` لإدراج لم يعد في الكتالوج). المتاح يعود بعنوانه واسم ترخيصه وسعره الحاليين؛ وغير المتاح يعود كما أُضيف
 * مع سببه. الحصرية النشطة تمنع كل ترخيص على المادة، والمحجوزة في طلب جارٍ تمنع الحصري وحده.
 */
export function reconcile(item: CartItem, listing: CatalogItem | null): { item: CartItem; change: CartChange | null } {
  const offer = listing?.offers.find(o => o.license_template_id === item.license_template_id);
  if (!listing || !offer) return { item, change: { kind: "gone" } };
  if (listing.exclusive_unavailable_until) return { item, change: { kind: "held", until: listing.exclusive_unavailable_until } };
  if (offer.type === "exclusive_temporary" && !listing.exclusive_available) return { item, change: { kind: "held", until: null } };
  const current: CartItem = { ...item, title: listing.title, license: offer.name, license_type: offer.type, price: offer.price };
  const same = offer.price.amount_minor === item.price.amount_minor && offer.price.currency === item.price.currency;
  return { item: current, change: same ? null : { kind: "price", from: item.price, to: offer.price } };
}

/** الطلب بعملة واحدة، فالسلة كذلك: عملة البنود الأخرى إن خالفت عملة المرشّح، أو `null`. تبديل ترخيص الإدراج نفسه لا يُحسب. */
export function currencyConflict(items: readonly CartItem[], candidate: { listing_id: string; price: Price }): Price["currency"] | null {
  return items.find(i => i.listing_id !== candidate.listing_id && i.price.currency !== candidate.price.currency)?.price.currency ?? null;
}
