import type { components } from "@/generated/schema";

// التراخيص الصادرة وتنزيل حزمة التسليم (v0.3، ADR 0025 الجزءان 4 و9)؛ يطابقها contract-drift مع OpenAPI.
export type IssuedLicense = components["schemas"]["License"];
type Role = components["schemas"]["RoleName"];
export const licenseReaders = ["system_admin", "finance", "rights_officer", "buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const licenseDownloaders = ["buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const licenseStatuses = ["active", "expired", "revoked"] as const satisfies readonly components["schemas"]["LicenseStatus"][];

const text = (v: { ar: string; en: string }) => ({ ar: v.ar, en: v.en });
/** الترخيص للمتصفح بقائمة بيضاء؛ الشروط مجمّدة كما وافق عليها المشتري. */
export function safeLicense(l: IssuedLicense): IssuedLicense {
  const t = l.terms;
  return {
    id: l.id, license_number: l.license_number, order_id: l.order_id, order_item_id: l.order_item_id, organization_id: l.organization_id, listing_id: l.listing_id, material_version: l.material_version,
    title: text(l.title), license_template_id: l.license_template_id, license_version: l.license_version,
    terms: { type: t.type, name: text(t.name), terms: text(t.terms), usage_media: [...t.usage_media], territory: t.territory.kind === "countries" ? { kind: "countries", countries: [...(t.territory.countries ?? [])] } : { kind: "worldwide" }, term_days: t.term_days ?? null, exclusivity_hours: t.exclusivity_hours ?? null, deliverables: [...t.deliverables], attribution: text(t.attribution), prohibitions: [...t.prohibitions] },
    price: { amount_minor: l.price.amount_minor, currency: l.price.currency }, status: l.status, revoked_reason: l.revoked_reason ?? null,
    valid_from: l.valid_from, valid_until: l.valid_until ?? null, exclusive_until: l.exclusive_until ?? null, issued_at: l.issued_at, delivery_ready: l.delivery_ready === true,
  };
}
/** رابط حزمة التسليم الموقّع: لا يُوجَّه المتصفح إلى أصل خارج أصول التخزين في الإعداد. */
export function allowedDownload(value: unknown, origins: readonly string[]) {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return origins.includes(url.origin) && !url.username && !url.password; } catch { return false; }
}
