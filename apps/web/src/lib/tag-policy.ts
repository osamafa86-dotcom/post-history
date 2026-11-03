import type { components, operations } from "@/generated/schema";
import { uuid } from "./query";
import { codePoints, validText } from "./admin-text";

// إدارة الوسوم (A2، ADR 0098): أنواع العقد المولَّدة؛ يطابق contract-drift الأدوار والحدود مع OpenAPI، وليست نماذج بديلة.
export type TagSuggestions = components["schemas"]["TagSuggestions"];
export type TagSuggestionsUpdate = components["schemas"]["TagSuggestionsUpdate"];
export type TagUsage = components["schemas"]["TagUsage"];
export type TagUsagePage = components["schemas"]["TagUsagePage"];
export type TagRewrite = components["schemas"]["TagRewrite"];
export type TagRewriteCreate = components["schemas"]["TagRewriteCreate"];
export type TagUsageQuery = NonNullable<operations["listTagUsage"]["parameters"]["query"]>;
type Role = components["schemas"]["RoleName"];

export const suggestionReaders = ["reporter", "supervisor", "editor_in_chief", "system_admin"] as const satisfies readonly Role[];
export const tagAdmins = ["system_admin"] as const satisfies readonly Role[];
export const rewriteModes = ["merge", "rename"] as const satisfies readonly TagRewrite["mode"][];
/** وسم من 1 إلى 40 نقطة ترميز، و12 وسمًا للمادة (ADR 0086)، وحتى 50 مقترحًا (ADR 0098). */
export const tagLimits = { tag: 40, perMaterial: 12, suggestions: 50, page: 50, cursor: 2048 } as const;

export const validTag = (value: unknown): value is string => validText(value, tagLimits.tag);
const dateTime = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const int = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** القائمة كما يقبلها العقد: حتى 50 وسمًا صالحًا بلا تكرار. */
export function validSuggestionList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= tagLimits.suggestions && value.every(validTag) && new Set(value).size === value.length;
}

/** جسم `PUT /tag-suggestions`: مفتاح `tags` وحده. */
export function suggestionsInput(body: Record<string, unknown>): TagSuggestionsUpdate | null {
  return Object.keys(body).join() === "tags" && validSuggestionList(body.tags) ? { tags: [...body.tags] } : null;
}
/** جسم `POST /tag-rewrites`: الأصل والهدف وسمان صالحان مختلفان. */
export function rewriteInput(body: Record<string, unknown>): TagRewriteCreate | null {
  return Object.keys(body).sort().join() === "source,target" && validTag(body.source) && validTag(body.target) && body.source !== body.target ? { source: body.source, target: body.target } : null;
}

/** مرشّحات `GET /tags`: جزء من الوسم، والمقترحة أو غيرها، والمؤشّر والحد. */
export function tagUsageQuery(params: URLSearchParams): TagUsageQuery {
  if ([...params.keys()].some(key => !["q", "suggested", "cursor", "limit"].includes(key) || params.getAll(key).length > 1)) throw new Error("Invalid query");
  const q = params.get("q"), suggested = params.get("suggested"), cursor = params.get("cursor"), limit = params.get("limit") ?? String(tagLimits.page);
  if (q !== null && (q.length === 0 || codePoints(q) > tagLimits.tag)) throw new Error("Invalid search");
  if (suggested !== null && !["true", "false"].includes(suggested)) throw new Error("Invalid filter");
  if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > tagLimits.cursor) throw new Error("Invalid page");
  return { limit: +limit, ...(q ? { q } : {}), ...(suggested !== null ? { suggested: suggested === "true" } : {}), ...(cursor ? { cursor } : {}) };
}

/** القائمة كاملة أو لا شيء: إسقاط وسم منها بصمت ثم استبدالها كان سيحذفه من القائمة الحقيقية. */
export function safeSuggestions(value: TagSuggestions): TagSuggestions {
  if (!validSuggestionList(value.tags) || !int(value.version, 1) || !dateTime(value.updated_at)) throw new Error("Invalid suggestions");
  return { tags: [...value.tags], version: value.version, updated_at: value.updated_at };
}
export function safeTagUsage(item: TagUsage): TagUsage | null {
  if (!validTag(item.tag) || !int(item.material_count, 0)) return null;
  return { tag: item.tag, material_count: item.material_count, last_used_at: dateTime(item.last_used_at) ? item.last_used_at : null, suggested_position: int(item.suggested_position, 1, tagLimits.suggestions) ? item.suggested_position : null };
}
export function safeTagUsagePage(page: TagUsagePage): TagUsagePage {
  return { items: page.items.map(safeTagUsage).filter((item): item is TagUsage => item !== null), next_cursor: typeof page.next_cursor === "string" && page.next_cursor.length <= tagLimits.cursor ? page.next_cursor : null };
}
export function safeRewrite(value: TagRewrite): TagRewrite {
  if (!uuid.test(value.id) || !validTag(value.source) || !validTag(value.target) || !(rewriteModes as readonly string[]).includes(value.mode) || !int(value.materials_updated, 0) || !dateTime(value.created_at) || !uuid.test(value.created_by)) throw new Error("Invalid rewrite");
  return { id: value.id, source: value.source, target: value.target, mode: value.mode, materials_updated: value.materials_updated, created_at: value.created_at, created_by: value.created_by };
}

/** الوضع المتوقَّع قبل الطلب كما يقرره الخادم: دمج إن كان الهدف مستعملًا أو مقترحًا، وإلا إعادة تسمية. الخادم يحسم لحظة التنفيذ. */
export function expectedMode(target: string, known: Iterable<string>): TagRewrite["mode"] {
  for (const tag of known) if (tag === target) return "merge";
  return "rename";
}

/** مسافة التحرير بنقاط الترميز، لاقتراح وسم قريب («مياة» من «مياه»). */
export function editDistance(a: string, b: string) {
  const x = Array.from(a), y = Array.from(b);
  let previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[y.length];
}

/**
 * هدف دمج مقترح لوسم من المراسلين (A2: «دمج بـ …»): أقرب وسم مقترح بمسافة تحرير 2 فأقل، والأقرب ثم الأعلى موضعًا. مجرد ملء مسبق
 * للحوار؛ التنفيذ بتأكيد صريح يقول أثره.
 */
export function mergeHint(tag: string, suggestions: readonly string[]): string | null {
  let best: { tag: string; distance: number } | null = null;
  for (const candidate of suggestions) {
    if (candidate === tag) continue;
    const distance = editDistance(tag, candidate);
    if (distance <= 2 && distance < Math.max(codePoints(tag), codePoints(candidate)) && (!best || distance < best.distance)) best = { tag: candidate, distance };
  }
  return best?.tag ?? null;
}

/** نقل عنصر في القائمة (السحب أو زرّا الترتيب)؛ قائمة جديدة لا تعديل في مكانها. */
export function moveTag(list: readonly string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list], [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
