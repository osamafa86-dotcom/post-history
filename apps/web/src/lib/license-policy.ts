import type { components } from "@/generated/schema";

// قيم قوالب التراخيص (v0.3، ADR 0025)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type TemplateInput = components["schemas"]["LicenseTemplateInput"];
export type Template = components["schemas"]["LicenseTemplate"];
type LicenseType = components["schemas"]["LicenseType"];
export const templateRoles = ["system_admin", "rights_officer", "editor_in_chief", "finance"] as const satisfies readonly components["schemas"]["RoleName"][];
export const templateWriters = ["system_admin", "rights_officer"] as const satisfies readonly components["schemas"]["RoleName"][];
export const licenseTypes = ["editorial_single", "editorial_term", "exclusive_temporary", "commercial"] as const satisfies readonly LicenseType[];
export const usageMedia = ["tv", "web", "social", "documentary", "advertising"] as const satisfies readonly TemplateInput["usage_media"][number][];
// التفريغ لا يُرخَّص ولا يُصدَّر (R11)، فلا يُعرض خيارًا.
export const deliverables = ["original", "produced", "audio", "stills"] as const satisfies readonly TemplateInput["deliverables"][number][];
export const prohibitions = ["resale", "advertising", "ai_training", "re_editing"] as const satisfies readonly TemplateInput["prohibitions"][number][];
export const currencies = ["USD", "ILS"] as const satisfies readonly components["schemas"]["Currency"][];
export const termRequired: readonly LicenseType[] = ["editorial_term", "exclusive_temporary"];
export const templateLimits = { text: 4000, countries: 250, termMin: 1, termMax: 3650, hoursMin: 24, hoursMax: 168, amountMax: 100000000000 } as const;

const keys = ["type", "name", "terms", "usage_media", "territory", "term_days", "exclusivity_hours", "deliverables", "attribution", "prohibitions", "base_price", "enabled"];
const subset = <T>(value: unknown, allowed: readonly T[], min = 0): value is T[] => Array.isArray(value) && value.length >= min && new Set(value).size === value.length && value.every(v => (allowed as readonly unknown[]).includes(v));
const int = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const localized = (value: unknown): value is { ar: string; en: string } => plain(value) && Object.keys(value).sort().join() === "ar,en" && [value.ar, value.en].every(text => typeof text === "string" && text.trim().length > 0 && Array.from(text).length <= templateLimits.text);

/** قالب كامل صالح بقواعد العقد، أو null. الخادم هو الحكم النهائي؛ هذا يمنع إرسال ما يُرفض حتمًا. */
export function templateInput(body: Record<string, unknown>): TemplateInput | null {
  const b = body;
  if (Object.keys(b).some(key => !keys.includes(key)) || !licenseTypes.includes(b.type as LicenseType)) return null;
  if (!localized(b.name) || !localized(b.terms) || !localized(b.attribution)) return null;
  if (!subset(b.usage_media, usageMedia, 1) || !subset(b.deliverables, deliverables, 1) || !subset(b.prohibitions, prohibitions)) return null;
  // تدريب الذكاء الاصطناعي محظور دائمًا إلا بإذن مستقل خارج القالب.
  if (!(b.prohibitions as string[]).includes("ai_training")) return null;
  const territory = b.territory;
  if (!plain(territory) || Object.keys(territory).some(key => !["kind", "countries"].includes(key))) return null;
  if (territory.kind === "worldwide" ? territory.countries !== undefined : territory.kind !== "countries" || !Array.isArray(territory.countries) || territory.countries.length < 1 || territory.countries.length > templateLimits.countries || new Set(territory.countries).size !== territory.countries.length || !territory.countries.every(c => typeof c === "string" && /^[A-Z]{2}$/.test(c))) return null;
  const term = b.term_days ?? null, hours = b.exclusivity_hours ?? null;
  if (term !== null && !int(term, templateLimits.termMin, templateLimits.termMax) || termRequired.includes(b.type as LicenseType) && term === null) return null;
  if (b.type === "exclusive_temporary" ? !int(hours, templateLimits.hoursMin, templateLimits.hoursMax) : hours !== null) return null;
  const price = b.base_price;
  if (!plain(price) || Object.keys(price).sort().join() !== "amount_minor,currency" || !int(price.amount_minor, 0, templateLimits.amountMax) || !currencies.includes(price.currency as typeof currencies[number])) return null;
  if (typeof b.enabled !== "boolean") return null;
  const text = (v: { ar: string; en: string }) => ({ ar: v.ar, en: v.en });
  return {
    type: b.type as LicenseType, name: text(b.name), terms: text(b.terms), usage_media: b.usage_media, attribution: text(b.attribution),
    territory: territory.kind === "worldwide" ? { kind: "worldwide" } : { kind: "countries", countries: territory.countries as string[] },
    term_days: term as number | null, exclusivity_hours: hours as number | null, deliverables: b.deliverables, prohibitions: b.prohibitions,
    base_price: { amount_minor: price.amount_minor as number, currency: price.currency as TemplateInput["base_price"]["currency"] }, enabled: b.enabled,
  };
}
/** حقول الإدخال من قالب محفوظ، بمفاتيح العقد وحدها. */
export const inputOf = (template: Template): TemplateInput => Object.fromEntries(keys.map(key => [key, (template as Record<string, unknown>)[key] ?? null])) as TemplateInput;
/** القالب للمتصفح بقائمة بيضاء. */
export function safeTemplate(template: Template): Template {
  return { ...inputOf(template), id: template.id, version: template.version, created_at: template.created_at, created_by: template.created_by };
}
export const emptyTemplate = (): TemplateInput => ({
  type: "editorial_single", name: { ar: "", en: "" }, terms: { ar: "", en: "" }, usage_media: ["tv", "web"], territory: { kind: "worldwide" },
  term_days: null, exclusivity_hours: null, deliverables: ["original"], attribution: { ar: "", en: "" }, prohibitions: ["resale", "ai_training"],
  base_price: { amount_minor: 0, currency: "USD" }, enabled: true,
});
