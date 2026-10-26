import type { components } from "@/generated/schema";
import { currencies, int, localized, plain, templateLimits } from "./license-policy";

// إدراج المادة في الكتالوج (v0.3، ADR 0025)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type ListingInput = components["schemas"]["CatalogListingInput"];
export type Listing = components["schemas"]["CatalogListing"];
export const listingReaders = ["system_admin", "rights_officer", "editor_in_chief", "finance"] as const satisfies readonly components["schemas"]["RoleName"][];
export const listingWriters = ["system_admin", "rights_officer"] as const satisfies readonly components["schemas"]["RoleName"][];
export const listingStates = ["draft", "listed", "suspended"] as const satisfies readonly components["schemas"]["ListingState"][];
export const listingLimits = { offers: 10, shots: 200 } as const;

const keys = ["title", "description", "shot_list", "offers", "commercial_allowed", "state"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = (value: unknown) => plain(value) && Object.keys(value).sort().join() === "amount_minor,currency" && int(value.amount_minor, 0, templateLimits.amountMax) && currencies.includes(value.currency as typeof currencies[number]);
const text = (v: { ar: string; en: string }) => ({ ar: v.ar, en: v.en });

/** إدراج كامل صالح بقواعد العقد، أو null. قيود الحقوق والدور التجاري يحكم فيها الخادم. */
export function listingInput(body: Record<string, unknown>): ListingInput | null {
  const b = body;
  if (Object.keys(b).some(key => !keys.includes(key)) || !localized(b.title) || !localized(b.description)) return null;
  if (!listingStates.includes(b.state as typeof listingStates[number]) || (b.commercial_allowed !== undefined && typeof b.commercial_allowed !== "boolean")) return null;
  const offers = b.offers, shots = b.shot_list ?? [];
  if (!Array.isArray(offers) || offers.length < 1 || offers.length > listingLimits.offers) return null;
  if (!offers.every(o => plain(o) && Object.keys(o).every(key => ["license_template_id", "price_override"].includes(key)) && typeof o.license_template_id === "string" && uuid.test(o.license_template_id) && (o.price_override === undefined || o.price_override === null || money(o.price_override)))) return null;
  if (new Set(offers.map(o => (o as Record<string, unknown>).license_template_id)).size !== offers.length) return null;
  if (!Array.isArray(shots) || shots.length > listingLimits.shots || !shots.every(s => plain(s) && Object.keys(s).sort().join() === "label,start_ms" && int(s.start_ms, 0, Number.MAX_SAFE_INTEGER) && localized(s.label))) return null;
  return {
    title: text(b.title), description: text(b.description), state: b.state as ListingInput["state"], commercial_allowed: b.commercial_allowed === true,
    shot_list: (shots as { start_ms: number; label: { ar: string; en: string } }[]).map(s => ({ start_ms: s.start_ms, label: text(s.label) })),
    offers: (offers as { license_template_id: string; price_override?: { amount_minor: number; currency: "USD" | "ILS" } | null }[]).map(o => ({ license_template_id: o.license_template_id, price_override: o.price_override ? { amount_minor: o.price_override.amount_minor, currency: o.price_override.currency } : null })),
  };
}
export const inputOf = (listing: Listing): ListingInput => ({ title: listing.title, description: listing.description, shot_list: listing.shot_list ?? [], offers: listing.offers.map(o => ({ license_template_id: o.license_template_id, price_override: o.price_override ?? null })), commercial_allowed: listing.commercial_allowed ?? false, state: listing.state });
/** الإدراج للمتصفح بقائمة بيضاء. */
export function safeListing(listing: Listing): Listing {
  return { ...inputOf(listing), id: listing.id, material_id: listing.material_id, material_version: listing.material_version, suspended_reason: listing.suspended_reason ?? null, listed_at: listing.listed_at ?? null, created_at: listing.created_at, updated_at: listing.updated_at, updated_by: listing.updated_by };
}
export const emptyListing = (title: string): ListingInput => ({ title: { ar: title, en: "" }, description: { ar: "", en: "" }, shot_list: [], offers: [], commercial_allowed: false, state: "draft" });
