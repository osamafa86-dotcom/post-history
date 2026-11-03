// قراءات لوحة الإدارة الاصطناعية لخادم الاختبار (ADR 0098، 0099): حسابات الطاقم، والوسوم وقائمتها المقترحة، وهوية المنصة، ومستحقات
// المساهمين، ومشتريات المؤسسات. أسماء وأماكن ومبالغ متخيَّلة، وحقول زائدة («never-display-canary» والبريد) ليثبت الاختبار أن الـBFF
// يقصّها. للاختبار والقياس المحلي فقط؛ لا يدخل حزمة التطبيق.
import { randomUUID } from "node:crypto";
import type { Me } from "../src/lib/types";
import type { StaffUser } from "../src/lib/staff-policy";
import type { TagSuggestions } from "../src/lib/tag-policy";
import type { PlatformSettings } from "../src/lib/platform-policy";

type Reply = { status: number; value: unknown; etag?: string } | null;
type Staff = StaffUser & { email: string; created_at: string };
const staff: Staff[] = [], usage = new Map<string, { count: number; last: string | null }>();
// نطاقات المشرف (A1، ADR 0104): فارغ = كل المكاتب، والمحافظة باسم محافظة مكتب موجود.
type Scope = { kind: "office" | "governorate"; id: string };
const scopes = new Map<string, Scope[]>(), officeGovernorates = ["محافظة تجريبية ١", "محافظة تجريبية ٢", "محافظة تجريبية ٣"];
const editable = ["reporter", "supervisor", "producer", "editor_in_chief", "rights_officer", "finance"];
let suggestions: TagSuggestions, platform: PlatformSettings;
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const usd = (cents: number) => ({ amount_minor: cents, currency: "USD" as const });
const has = (user: Me, ...roles: string[]) => user.roles.some(role => roles.includes(role.name));
const page = <T>(items: T[], url: URL, fallback = 50) => {
  const start = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? fallback);
  return { items: items.slice(start, start + limit), next_cursor: start + limit < items.length ? String(start + limit) : null };
};

export function resetAdmin() {
  const row = (n: number, work_name: string | null, roles: StaffUser["roles"], governorate: string | null, status: StaffUser["status"], last: number | null): Staff =>
    ({ id: id(n), work_name, roles, governorate, status, last_active_at: last === null ? null : ago(last), email: `staff${n}@example.test`, created_at: ago(n * 86400000) });
  staff.splice(0, staff.length,
    row(1, "مدير تجريبي ١", ["system_admin"], null, "active", 0),
    row(2, "محرر تجريبي ١", ["supervisor"], null, "active", 240000),
    row(3, "مراسل تجريبي ١", ["reporter"], "محافظة تجريبية ١", "active", 3600000),
    row(4, "مراسلة تجريبية ٢", ["reporter"], "محافظة تجريبية ٢", "active", 86400000),
    row(5, "مراسل تجريبي ٣", ["reporter"], "محافظة تجريبية ٣", "suspended", 6 * 86400000),
    row(6, "مراسل تجريبي ٤", ["reporter"], "محافظة تجريبية ١", "active", null),
    row(7, "مونتير تجريبي ١", ["producer"], null, "active", 600000),
    row(8, "رئيس تحرير تجريبي", ["editor_in_chief"], null, "active", 7200000),
    row(9, null, ["finance"], null, "recovery", 3 * 86400000),
    row(10, "مسؤول حقوق تجريبي", ["rights_officer", "supervisor"], null, "active", 900000),
    row(11, "مراسل تجريبي ٥", ["reporter"], "محافظة تجريبية ٢", "active", 1800000),
    row(12, "مراسل تجريبي ٦", ["reporter"], "محافظة تجريبية ٣", "active", 5400000),
  );
  scopes.clear(); scopes.set(id(2), [{ kind: "governorate", id: "محافظة تجريبية ١" }]);
  usage.clear();
  for (const [tag, count, days] of [["وسم تجريبي ١", 412, 0], ["وسم تجريبي ٢", 318, 0], ["وسم تجريبي ٣", 207, 1], ["وسم تجريبى ٣", 9, 3], ["خيمة", 64, 0], ["خيام", 21, 7], ["مياه", 30, 2], ["مياة", 4, 9]] as const) usage.set(tag, { count, last: ago(days * 86400000 + 60000) });
  suggestions = { tags: ["وسم تجريبي ١", "وسم تجريبي ٢", "وسم تجريبي ٣", "مياه", "خيام", "مدارس"], version: 3, updated_at: "2026-11-03T09:00:00Z" };
  platform = { platform_name: "المكتبة المرئية", app_name: "ميدان بوست", watermark_text: "معاينة · المكتبة المرئية", version: 1, updated_at: "2026-11-03T09:00:00Z" };
}

/** حساب طاقم بمعرّفه (رابط إعادة التعيين، ADR 0108): الإصدار يضعه في «استعادة جارية». */
export const staffAccount = (target: string) => staff.find(s => s.id === target) ?? null;

/** تغيير متزامن من جلسة أخرى: يرتفع الإصدار، فيردّ الاستبدال التالي بإصدار قديم 412. */
export function bumpAdmin(what: string | null) {
  if (what === "platform") platform = { ...platform, app_name: `${platform.app_name} ٢`, version: platform.version + 1, updated_at: new Date().toISOString() };
  else suggestions = { tags: [...suggestions.tags.filter(tag => tag !== "مدارس"), "وسم من جلسة أخرى"], version: suggestions.version + 1, updated_at: new Date().toISOString() };
}

function usageRows() {
  const tags = new Set([...usage.keys(), ...suggestions.tags]);
  return [...tags].map(tag => ({ tag, material_count: usage.get(tag)?.count ?? 0, last_used_at: usage.get(tag)?.last ?? null, suggested_position: suggestions.tags.includes(tag) ? suggestions.tags.indexOf(tag) + 1 : null, internal_note: "never-display-canary" }))
    .sort((a, b) => b.material_count - a.material_count || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

const rolesOf = (row: Staff) => row.roles.map(name => ({ name, scopes: name === "supervisor" ? scopes.get(row.id) ?? [] : [] }));

export function adminRead(url: URL, user: Me): Reply {
  const path = url.pathname;
  const rolesPath = /^\/v1\/users\/([^/]+)\/roles$/.exec(path);
  if (rolesPath) {
    if (!has(user, "system_admin")) return { status: 403, value: { code: "forbidden_role" } };
    const row = staff.find(s => s.id === rolesPath[1]); if (!row) return { status: 404, value: {} };
    return { status: 200, value: { user_id: row.id, roles: rolesOf(row), internal_note: "never-display-canary" } };
  }
  if (path === "/v1/users") {
    if (!has(user, "system_admin")) return { status: 403, value: { code: "forbidden_role" } };
    const roles = url.searchParams.getAll("role"), status = url.searchParams.get("status"), q = url.searchParams.get("q")?.toLowerCase();
    const items = staff.filter(s => (!roles.length || s.roles.some(r => roles.includes(r))) && (!status || s.status === status) && (!q || (s.work_name ?? "").toLowerCase().includes(q) || s.email.includes(q)))
      .map(s => ({ ...s, reporter_legal_name: "never-display-canary", device_id: "never-display-canary" }));
    const counts = new Map<string, number>(); for (const s of staff) for (const r of s.roles) counts.set(r, (counts.get(r) ?? 0) + 1);
    return { status: 200, value: { ...page(items, url), summary: { total: staff.length, suspended: staff.filter(s => s.status === "suspended").length, roles: [...counts].map(([role, count]) => ({ role, count })) } } };
  }
  if (path === "/v1/tag-suggestions") {
    if (!has(user, "reporter", "supervisor", "editor_in_chief", "system_admin")) return { status: 403, value: {} };
    return { status: 200, value: { ...suggestions, internal_note: "never-display-canary" }, etag: `"${suggestions.version}"` };
  }
  if (path === "/v1/tags") {
    if (!has(user, "system_admin")) return { status: 403, value: {} };
    const q = url.searchParams.get("q")?.toLowerCase(), suggested = url.searchParams.get("suggested");
    return { status: 200, value: page(usageRows().filter(row => (!q || row.tag.toLowerCase().includes(q)) && (suggested === null || (row.suggested_position !== null) === (suggested === "true"))), url) };
  }
  if (path === "/v1/platform-settings") {
    if (!has(user, "system_admin")) return { status: 403, value: {} };
    return { status: 200, value: { ...platform, internal_note: "never-display-canary" }, etag: `"${platform.version}"` };
  }
  if (path === "/v1/contributor-earnings") {
    if (!has(user, "system_admin", "finance")) return { status: 403, value: {} };
    const month = url.searchParams.get("month");
    if (!month) return { status: 400, value: { code: "validation_failed" } };
    const balance = (requestable: number, inPayout = 0) => ({ currency: "USD", pending: usd(0), available: usd(requestable), in_payout: usd(inPayout), paid: usd(0), reserve: usd(0), requestable: usd(requestable), minimum: usd(5000) });
    const contributor = (n: number, name: string | null, sales: number, gross: number, fees: number, b: ReturnType<typeof balance>) => ({ user_id: id(n), work_name: name, currency: "USD", sales, gross: usd(gross), fees_and_taxes: usd(fees), net: usd(gross - fees), share: usd(Math.round((gross - fees) * 0.3)), refunded: usd(0), share_basis_points: 3000, balance: b, email: "staff@example.test", buyer: "never-display-canary" });
    // الشهر الحالي وحده فيه بيعات، فالشهر السابق يعرض حالة الفراغ.
    const now = new Date(), current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const items = month !== current ? [] : [
      contributor(3, "مراسل تجريبي ١", 9, 231000, 23100, balance(62370)),
      contributor(4, "مراسلة تجريبية ٢", 6, 145000, 14500, balance(39150)),
      contributor(11, null, 3, 62000, 6200, balance(1674, 15000)),
      contributor(12, "مراسل تجريبي ٦", 1, 12000, 1200, balance(3240)),
    ];
    const sum = (key: "gross" | "fees_and_taxes" | "net" | "share" | "refunded") => usd(items.reduce((total, row) => total + row[key].amount_minor, 0));
    const totals = items.length ? [{ currency: "USD", contributors: items.length, sales: items.reduce((t, r) => t + r.sales, 0), gross: sum("gross"), fees_and_taxes: sum("fees_and_taxes"), net: sum("net"), share: sum("share"), refunded: sum("refunded"), share_basis_points: 3000 }] : [];
    return { status: 200, value: { month, ...page(items, url, 100), totals } };
  }
  if (path === "/v1/buyer-purchase-totals") {
    if (!has(user, "system_admin", "finance")) return { status: 403, value: {} };
    const year = Number(url.searchParams.get("year"));
    if (!year) return { status: 400, value: { code: "validation_failed" } };
    return { status: 200, value: { year, items: [{ organization_id: "90000000-0000-4000-8000-000000000001", currency: "USD", paid_orders: 12, paid: usd(842000), refunded: usd(12000), billing_email: "billing@example.test" }], next_cursor: null } };
  }
  return null;
}

const valid = (tag: unknown, max = 40) => typeof tag === "string" && Array.from(tag).length >= 1 && Array.from(tag).length <= max && tag.trim() === tag;
export function adminWrite(path: string, method: string, user: Me, body: Record<string, unknown>, ifMatch: string | undefined): Reply {
  if (path === "/v1/tag-suggestions" && method === "PUT") {
    if (!has(user, "system_admin")) return { status: 403, value: {} };
    if (ifMatch !== `"${suggestions.version}"`) return { status: 412, value: { message: "never-display-canary" } };
    const tags = body.tags as string[];
    if (!Array.isArray(tags) || tags.length > 50 || !tags.every(tag => valid(tag)) || new Set(tags).size !== tags.length) return { status: 422, value: { code: "validation_failed" } };
    if (JSON.stringify(tags) !== JSON.stringify(suggestions.tags)) suggestions = { tags: [...tags], version: suggestions.version + 1, updated_at: new Date().toISOString() };
    return { status: 200, value: suggestions, etag: `"${suggestions.version}"` };
  }
  if (path === "/v1/tag-rewrites" && method === "POST") {
    if (!has(user, "system_admin")) return { status: 403, value: {} };
    const source = String(body.source), target = String(body.target);
    if (!valid(body.source) || !valid(body.target) || source === target) return { status: 422, value: { code: "validation_failed" } };
    if (!usage.has(source) && !suggestions.tags.includes(source)) return { status: 404, value: {} };
    const mode = usage.has(target) || suggestions.tags.includes(target) ? "merge" : "rename", moved = usage.get(source) ?? { count: 0, last: null }, existing = usage.get(target);
    usage.delete(source);
    if (moved.count || existing) usage.set(target, { count: (existing?.count ?? 0) + moved.count, last: [existing?.last, moved.last].filter(Boolean).sort().at(-1) ?? null });
    if (suggestions.tags.includes(source)) suggestions = { tags: suggestions.tags.includes(target) ? suggestions.tags.filter(tag => tag !== source) : suggestions.tags.map(tag => tag === source ? target : tag), version: suggestions.version + 1, updated_at: new Date().toISOString() };
    return { status: 201, value: { id: randomUUID(), source, target, mode, materials_updated: moved.count, created_at: new Date().toISOString(), created_by: user.user_id } };
  }
  if (path === "/v1/platform-settings" && method === "PUT") {
    if (!has(user, "system_admin")) return { status: 403, value: {} };
    if (ifMatch !== `"${platform.version}"`) return { status: 412, value: { message: "never-display-canary" } };
    if (!valid(body.platform_name, 60) || !valid(body.app_name, 40) || !valid(body.watermark_text, 60)) return { status: 422, value: { code: "validation_failed" } };
    const next = { platform_name: String(body.platform_name), app_name: String(body.app_name), watermark_text: String(body.watermark_text) };
    if (next.platform_name !== platform.platform_name || next.app_name !== platform.app_name || next.watermark_text !== platform.watermark_text) platform = { ...next, version: platform.version + 1, updated_at: new Date().toISOString() };
    return { status: 200, value: platform, etag: `"${platform.version}"` };
  }
  const rolesPath = /^\/v1\/users\/([^/]+)\/roles$/.exec(path);
  if (rolesPath && method === "PUT") {
    if (!has(user, "system_admin")) return { status: 403, value: { code: "forbidden_role" } };
    const row = staff.find(s => s.id === rolesPath[1]); if (!row) return { status: 404, value: {} };
    if (row.id === user.user_id || row.roles.includes("system_admin")) return { status: 403, value: { code: "admin_quorum_required" } };
    const roles = body.roles as { name: string; scopes: Scope[] }[];
    const ok = Object.keys(body).join() === "roles" && Array.isArray(roles) && roles.length >= 1 && roles.length <= 7 && new Set(roles.map(r => r.name)).size === roles.length
      && roles.every(r => editable.includes(r.name) && Array.isArray(r.scopes) && (r.name === "supervisor" || !r.scopes.length) && r.scopes.every(scope => scope.kind === "governorate" ? officeGovernorates.includes(scope.id) : scope.kind === "office"));
    if (!ok) return { status: 422, value: { code: "validation_failed" } };
    row.roles = roles.map(r => r.name as StaffUser["roles"][number]); scopes.set(row.id, roles.find(r => r.name === "supervisor")?.scopes ?? []);
    return { status: 200, value: { user_id: row.id, roles: rolesOf(row) } };
  }
  const status = /^\/v1\/users\/([^/]+)\/status$/.exec(path);
  if (status && method === "PUT" && has(user, "system_admin")) { const row = staff.find(s => s.id === status[1]); if (row && (body.status === "active" || body.status === "suspended")) row.status = body.status; }
  return null;
}
