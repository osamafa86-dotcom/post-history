import type { components } from "@/generated/schema";

// الطلبات والدفع التجريبي (v0.3، ADR 0025 الجزء 4، ADR 0032)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type Order = components["schemas"]["Order"];
export type OrderCreate = components["schemas"]["OrderCreate"];
export type CheckoutSession = components["schemas"]["CheckoutSession"];
type Role = components["schemas"]["RoleName"];
export const orderReaders = ["system_admin", "finance", "buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const orderWriters = ["buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const orderStatuses = ["pending_payment", "paid", "cancelled", "expired", "refunded"] as const satisfies readonly components["schemas"]["OrderStatus"][];
export const orderLimits = { items: 20 } as const;
// المزوّد إعداد خادم يعود في الجلسة (ADR 0032)؛ لا يختاره المشتري. Stripe بوضع الاختبار وحده وعلى أصل صفحته المستضافة.
export const checkoutProviders = ["sandbox", "stripe"] as const satisfies readonly components["schemas"]["PaymentProvider"][];
export const stripeCheckoutOrigin = "https://checkout.stripe.com";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** طلب من السلة بقواعد العقد، أو null: بند لكل إدراج، وعملة واحدة يحكم فيها الخادم، والمجموع الذي رآه المشتري. */
export function orderCreate(body: Record<string, unknown>): OrderCreate | null {
  if (Object.keys(body).some(key => !["items", "expected_total"].includes(key))) return null;
  const items = body.items, total = body.expected_total;
  if (!Array.isArray(items) || items.length < 1 || items.length > orderLimits.items) return null;
  if (!items.every(i => plain(i) && Object.keys(i).sort().join() === "license_template_id,listing_id" && typeof i.listing_id === "string" && uuid.test(i.listing_id) && typeof i.license_template_id === "string" && uuid.test(i.license_template_id))) return null;
  if (new Set(items.map(i => (i as Record<string, unknown>).listing_id)).size !== items.length) return null;
  if (total !== undefined && !(plain(total) && Object.keys(total).sort().join() === "amount_minor,currency" && Number.isSafeInteger(total.amount_minor) && Number(total.amount_minor) >= 0 && ["USD", "ILS"].includes(String(total.currency)))) return null;
  return {
    items: (items as { listing_id: string; license_template_id: string }[]).map(i => ({ listing_id: i.listing_id, license_template_id: i.license_template_id })),
    ...(total ? { expected_total: { amount_minor: (total as { amount_minor: number }).amount_minor, currency: (total as { currency: "USD" | "ILS" }).currency } } : {}),
  };
}
/** الطلب للمتصفح بقائمة بيضاء. */
export function safeOrder(o: Order): Order {
  return {
    id: o.id, organization_id: o.organization_id, created_by: o.created_by, status: o.status, cancel_reason: o.cancel_reason ?? null, total: { amount_minor: o.total.amount_minor, currency: o.total.currency },
    items: o.items.map(i => ({ id: i.id, listing_id: i.listing_id, material_version: i.material_version, license_template_id: i.license_template_id, license_version: i.license_version, license_type: i.license_type, license_name: { ar: i.license_name.ar, en: i.license_name.en }, title: { ar: i.title.ar, en: i.title.en }, price: { amount_minor: i.price.amount_minor, currency: i.price.currency }, license_id: i.license_id ?? null })),
    expires_at: o.expires_at, paid_at: o.paid_at ?? null, created_at: o.created_at, updated_at: o.updated_at,
  };
}
/** صفحة الدفع المستضافة: لا يُوجَّه المتصفح إلى أصل خارج قائمة الإعداد، ولا إلى رابط بمستخدم أو كلمة مرور، ولا يُقبل مزوّد خارج العقد. ورابط Stripe على أصل صفحته وحده وبـ https. */
export function allowedCheckout(value: unknown, origins: readonly string[], provider: unknown = "sandbox") {
  if (typeof value !== "string" || !(checkoutProviders as readonly unknown[]).includes(provider)) return false;
  try {
    const url = new URL(value);
    if (!origins.includes(url.origin) || url.username || url.password || !["https:", "http:"].includes(url.protocol)) return false;
    return provider === "stripe" ? url.origin === stripeCheckoutOrigin : url.origin !== stripeCheckoutOrigin;
  } catch { return false; }
}
