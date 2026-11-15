import { dateTime } from "./query";
import type { components } from "@/generated/schema";
import { orderNumberPattern } from "./store-format";

// التراخيص الصادرة وتنزيل حزمة التسليم (v0.3، ADR 0025 الجزءان 4 و9)؛ يطابقها contract-drift مع OpenAPI.
export type IssuedLicense = components["schemas"]["License"];
type Role = components["schemas"]["RoleName"];
export const licenseReaders = ["system_admin", "finance", "rights_officer", "buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const licenseDownloaders = ["buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const licenseStatuses = ["active", "expired", "revoked"] as const satisfies readonly components["schemas"]["LicenseStatus"][];

const text = (v: { ar: string; en: string }) => ({ ar: v.ar, en: v.en });
/** الترخيص للمتصفح بقائمة بيضاء؛ الشروط مجمّدة كما وافق عليها المشتري. */
export function safeLicenseTerms(t: IssuedLicense["terms"]): IssuedLicense["terms"] {
  return { type: t.type, name: text(t.name), terms: text(t.terms), usage_media: [...t.usage_media], territory: t.territory.kind === "countries" ? { kind: "countries", countries: [...(t.territory.countries ?? [])] } : { kind: "worldwide" }, term_days: t.term_days ?? null, exclusivity_hours: t.exclusivity_hours ?? null, deliverables: [...t.deliverables], attribution: text(t.attribution), prohibitions: [...t.prohibitions] };
}
const deliveryCount = (c: components["schemas"]["LicenseDeliveryContent"]) => c.count === undefined ? 1 : c.count;
const nonnegative = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
export function safeLicense(l: IssuedLicense): IssuedLicense {
  const t = l.terms;
  return {
    id: l.id, license_number: l.license_number, order_id: l.order_id, ...(typeof l.order_number === "string" && orderNumberPattern.test(l.order_number) ? { order_number: l.order_number } : {}), order_item_id: l.order_item_id, organization_id: l.organization_id, listing_id: l.listing_id, material_version: l.material_version,
    title: text(l.title), license_template_id: l.license_template_id, license_version: l.license_version,
    terms: safeLicenseTerms(t),
    price: { amount_minor: l.price.amount_minor, currency: l.price.currency }, status: l.status, revoked_reason: l.revoked_reason ?? null,
    ...(l.delivery_contents ? { delivery_contents: l.delivery_contents.filter(c => ["original", "produced", "audio", "stills"].includes(c.deliverable) && ["video/mp4", "audio/mp4", "image/jpeg"].includes(c.mime_type) && Number.isSafeInteger(deliveryCount(c)) && deliveryCount(c) > 0).map(c => ({ deliverable: c.deliverable, mime_type: c.mime_type, count: deliveryCount(c), duration_ms: nonnegative(c.duration_ms), width: nonnegative(c.width), height: nonnegative(c.height) })) } : {}),
    ...(l.delivery_size_bytes !== undefined ? { delivery_size_bytes: nonnegative(l.delivery_size_bytes) } : {}),
    valid_from: l.valid_from, valid_until: l.valid_until ?? null, exclusive_until: l.exclusive_until ?? null, issued_at: l.issued_at, delivery_ready: l.delivery_ready === true,
  };
}
/**
 * ما تملكه المؤسسة ساريًا على إدراج (S2): رقم ترخيصها لكل قالب، ونهاية حصريتها هي عليه إن كانت قائمة. الساري ما حالته `active` ولم تمضِ نهايته
 * (وإن لم يحدّث الخادم حالته بعد)؛ المُبطل والمنتهي وتراخيص الإدراجات الأخرى خارجه.
 */
export function heldOn(licenses: readonly IssuedLicense[], listingId: string, now: number): { numbers: Record<string, string>; exclusiveUntil: string | null } {
  const numbers: Record<string, string> = {}; let exclusiveUntil: string | null = null;
  for (const l of licenses) {
    if (l.listing_id !== listingId || l.status !== "active" || (l.valid_until && Date.parse(l.valid_until) <= now)) continue;
    numbers[l.license_template_id] ??= l.license_number;
    if (l.exclusive_until && Date.parse(l.exclusive_until) > now && (!exclusiveUntil || l.exclusive_until > exclusiveUntil)) exclusiveUntil = l.exclusive_until;
  }
  return { numbers, exclusiveUntil };
}
/** رابط حزمة التسليم الموقّع: لا يُوجَّه المتصفح إلى أصل خارج أصول التخزين في الإعداد. */
export function allowedDownload(value: unknown, origins: readonly string[]) {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return origins.includes(url.origin) && !url.username && !url.password; } catch { return false; }
}

/** من يقرأ عدد التراخيص الفاعلة على مادة قبل خروج حقوقها من `sellable` (حوار تحويل الحقوق، والمالية)؛ كما في `x-roles`. */
export const activeLicenseReaders = ["system_admin", "editor_in_chief", "rights_officer", "finance"] as const satisfies readonly components["schemas"]["RoleName"][];
export type ActiveLicenses = components["schemas"]["MaterialActiveLicenses"];
/** العددان وحدهما، صحيحين غير سالبين؛ غير ذلك لا يُعرض. */
export function safeActiveLicenses(value: ActiveLicenses): ActiveLicenses | null {
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  return count(value?.active_licenses) && count(value?.organizations) ? { active_licenses: value.active_licenses, organizations: value.organizations } : null;
}
/** أسباب الإبطال التي يصفّي بها العقد قائمة التراخيص. */
export const revokedReasons = ["refunded", "rights_withdrawn", "manual"] as const satisfies readonly NonNullable<IssuedLicense["revoked_reason"]>[];
/** من يرى قائمة «أُبطلت لسبب حقوقي ولم تُسترد»: من يقرّر الاسترداد. */
export const refundReviewers = ["system_admin", "finance"] as const satisfies readonly components["schemas"]["RoleName"][];
/** صيغة رقم الترخيص كما في العقد؛ أي رقم آخر لا يُرسل إلى الخادم. */
export const licenseNumberPattern = /^PH-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{10}$/;
/**
 * الرقم كما يكتبه قارئ من ورقة: بلا فراغات، بحروف كبيرة، بأرقام لاتينية وشرطة عادية، وبشرطتيه إن غابتا. والحروف التي لا يحملها الترميز
 * (O وI وL) تُقرأ أرقامها (0 و1) كما في ترميز Crockford. ما لا يصير رقمًا بصيغة العقد يعود كما نُظِّف، فيرفضه النمط.
 */
export function normalizeLicenseNumber(value: string): string {
  const latin = value.normalize("NFKC").replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[\u06f0-\u06f9]/g, d => String(d.charCodeAt(0) - 0x6f0));
  const plain = latin.replace(/[\u2010-\u2015\u2212]/g, "-").replace(/\s+/g, "").toUpperCase();
  const match = /^PH-?([0-9OIL]{4})-?([0-9A-Z]{10})$/.exec(plain);
  if (!match) return plain;
  const read = (part: string) => part.replace(/O/g, "0").replace(/[IL]/g, "1");
  return `PH-${read(match[1])}-${read(match[2])}`;
}
/** مهلة تجهيز حزمة التسليم: بعدها يُقال للمشتري إن التجهيز تأخر وإلى من يتوجّه، بدل «عُد بعد قليل» بلا نهاية. */
export const deliveryLateAfterMs = 15 * 60 * 1000;
export const deliveryLate = (license: Pick<IssuedLicense, "status" | "delivery_ready" | "issued_at">, now: number) =>
  license.status === "active" && !license.delivery_ready && now - Date.parse(license.issued_at) > deliveryLateAfterMs;
export type PublicVerification = { license_number: string; status: IssuedLicense["status"]; valid_until: string | null };
/**
 * صفحة التحقق العامة (P2): الحقول الثلاثة التي يغلق عليها العقد وحدها (#406 بعد قرار الأمن على #383): الرقم والحالة والنهاية، وإن أعاد الخادم
 * أبعادًا أخرى. النهاية تاريخ صالح أو `null` (بلا انتهاء)، وأي قيمة أخرى تُقرأ `null` (ADR 0103).
 */
export const safeVerification = (v: components["schemas"]["LicenseVerification"]): PublicVerification => ({ license_number: v.license_number, status: v.status,
  valid_until: typeof v.valid_until === "string" && dateTime.test(v.valid_until) && Number.isFinite(Date.parse(v.valid_until)) ? v.valid_until : null });
