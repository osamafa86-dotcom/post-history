import type { components, operations } from "@/generated/schema";
import { uuid } from "./query";
import { workName } from "./work-name";
import { uploadRoles } from "./upload-policy";
import { assignRoles, myTaskRoles } from "./assignment-policy";
import { listingWriters } from "./listing-policy";
import { payoutStaff } from "./earnings-policy";

// حسابات الطاقم (A1، ADR 0099): أنواع العقد المولَّدة؛ يطابق contract-drift القيم مع OpenAPI، وليست نماذج بديلة.
export type StaffUser = components["schemas"]["StaffUser"];
export type StaffUserPage = components["schemas"]["StaffUserPage"];
export type StaffUserStatus = components["schemas"]["StaffUserStatus"];
export type StaffQuery = NonNullable<operations["listUsers"]["parameters"]["query"]>;
type Role = components["schemas"]["RoleName"];

export const staffReaders = ["system_admin"] as const satisfies readonly Role[];
export const staffStatuses = ["active", "suspended", "recovery"] as const satisfies readonly StaffUserStatus[];
/** أدوار الطاقم بترتيب الرقاقات والمصفوفة؛ دورا المشتري في A5 لا هنا. */
export const staffRoles = ["reporter", "supervisor", "producer", "editor_in_chief", "rights_officer", "finance", "system_admin"] as const satisfies readonly Role[];
const allRoles = [...staffRoles, "buyer_admin", "buyer_member"] as const satisfies readonly Role[];
export const staffLimits = { q: 80, roles: 9, cursor: 2048, page: 50 } as const;

/**
 * مصفوفة «ما يستطيعه كل دور» (A1): كل سطر من ثوابت الأدوار التي يطابقها contract-drift مع `x-roles` في العقد، فلا تقول المصفوفة
 * غير ما يسمح به الخادم.
 */
export const capabilities = [
  { key: "upload", roles: uploadRoles },
  { key: "assign", roles: assignRoles },
  { key: "production", roles: myTaskRoles },
  { key: "rights", roles: listingWriters },
  { key: "money", roles: payoutStaff },
  { key: "admin", roles: staffReaders },
] as const satisfies readonly { key: string; roles: readonly Role[] }[];

const plainText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && Array.from(value).length <= max && !/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value);
const dateTime = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** مرشّحات القائمة كما في العقد: `role` يتكرر (حتى 9 بلا تكرار)، و`status`، و`q` من 1 إلى 80، والمؤشّر والحد. غيرها يُرفض. */
export function staffQuery(params: URLSearchParams): StaffQuery {
  const allowed = ["role", "status", "q", "cursor", "limit"];
  if ([...params.keys()].some(key => !allowed.includes(key) || (key !== "role" && params.getAll(key).length > 1))) throw new Error("Invalid query");
  const roles = params.getAll("role"), status = params.get("status"), q = params.get("q"), cursor = params.get("cursor"), limit = params.get("limit") ?? String(staffLimits.page);
  if (roles.length > staffLimits.roles || new Set(roles).size !== roles.length || roles.some(role => !(allRoles as readonly string[]).includes(role))) throw new Error("Invalid role");
  if (status !== null && !(staffStatuses as readonly string[]).includes(status)) throw new Error("Invalid status");
  if (q !== null && (q.length === 0 || Array.from(q).length > staffLimits.q)) throw new Error("Invalid search");
  if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > staffLimits.cursor) throw new Error("Invalid page");
  return { limit: +limit, ...(roles.length ? { role: roles as Role[] } : {}), ...(status ? { status: status as StaffUserStatus } : {}), ...(q ? { q } : {}), ...(cursor ? { cursor } : {}) };
}

/** الحساب بقائمة بيضاء: لا بريد ولا اسم حقيقي ولا جهاز ولا موقع، وإن أعادها خادم خاطئ. الصف المخالف يسقط. */
export function safeStaffUser(user: StaffUser): StaffUser | null {
  if (!uuid.test(user.id) || !(staffStatuses as readonly string[]).includes(user.status) || !Array.isArray(user.roles)) return null;
  return {
    id: user.id, work_name: workName(user.work_name), roles: user.roles.filter(role => (allRoles as readonly string[]).includes(role)),
    governorate: plainText(user.governorate, 64) ? user.governorate : null, status: user.status, last_active_at: dateTime(user.last_active_at) ? user.last_active_at : null,
  };
}

export function safeStaffPage(page: StaffUserPage): StaffUserPage {
  const summary = page.summary;
  if (!summary || !count(summary.total) || !count(summary.suspended) || !Array.isArray(summary.roles)) throw new Error("Invalid staff summary");
  return {
    items: page.items.map(safeStaffUser).filter((user): user is StaffUser => user !== null),
    next_cursor: typeof page.next_cursor === "string" && page.next_cursor.length <= staffLimits.cursor ? page.next_cursor : null,
    summary: { total: summary.total, suspended: summary.suspended, roles: summary.roles.filter(row => (allRoles as readonly string[]).includes(row.role) && count(row.count)).map(row => ({ role: row.role, count: row.count })) },
  };
}

// أدوار حساب الطاقم (A1، ADR 0104، 0105): القراءة والاستبدال لمدير النظام وحده كما في `x-roles`.
export type StaffRoles = components["schemas"]["StaffRoles"];
export type StaffRolesUpdate = components["schemas"]["StaffRolesUpdate"];
export type StaffRole = components["schemas"]["Role"];
export const roleEditors = ["system_admin"] as const satisfies readonly Role[];
/** ما يُغيَّر من الويب: أدوار الطاقم بلا `system_admin` (إجراء الشخصين، ADR 0005 و0030). */
export const editableRoles = ["reporter", "supervisor", "producer", "editor_in_chief", "rights_officer", "finance"] as const satisfies readonly Role[];
export const roleLimits = { roles: 7, scopes: 20, governorate: 64 } as const;

function scopesOf(value: unknown, name: string): StaffRole["scopes"] | null {
  if (!Array.isArray(value) || value.length > roleLimits.scopes || (value.length > 0 && name !== "supervisor")) return null;
  const seen = new Set<string>(), scopes: StaffRole["scopes"] = [];
  for (const scope of value) {
    if (!scope || typeof scope !== "object" || Array.isArray(scope) || Object.keys(scope).sort().join() !== "id,kind") return null;
    const { kind, id } = scope as { kind: unknown; id: unknown };
    if (kind === "office" ? typeof id !== "string" || !uuid.test(id) : kind === "governorate" ? !plainText(id, roleLimits.governorate) || id !== id.trim() : true) return null;
    const key = `${kind}:${id}`; if (seen.has(key)) return null; seen.add(key);
    scopes.push({ kind: kind as "office" | "governorate", id: id as string });
  }
  return scopes;
}
/** جسم الاستبدال بقواعد العقد: دور طاقم قابل للتغيير مرة واحدة، والنطاق للمشرف وحده. غيره null فيُرد 422 دون سؤال الخادم. */
export function rolesInput(body: Record<string, unknown>): StaffRolesUpdate | null {
  if (Object.keys(body).join() !== "roles" || !Array.isArray(body.roles) || body.roles.length < 1 || body.roles.length > roleLimits.roles) return null;
  const names = new Set<string>(), roles: StaffRole[] = [];
  for (const role of body.roles) {
    if (!role || typeof role !== "object" || Array.isArray(role) || Object.keys(role).sort().join() !== "name,scopes") return null;
    const { name, scopes } = role as { name: unknown; scopes: unknown };
    if (typeof name !== "string" || !(editableRoles as readonly string[]).includes(name) || names.has(name)) return null;
    names.add(name);
    const valid = scopesOf(scopes, name); if (!valid) return null;
    roles.push({ name: name as Role, scopes: valid });
  }
  return { roles };
}
/** أدوار الحساب بقائمة بيضاء؛ الرد المخالف يرمي فيصير 502. */
export function safeStaffRoles(value: StaffRoles): StaffRoles {
  if (!value || !uuid.test(value.user_id) || !Array.isArray(value.roles)) throw new Error("Invalid roles");
  return {
    user_id: value.user_id,
    roles: value.roles.filter(role => (staffRoles as readonly string[]).includes(role.name) && Array.isArray(role.scopes)).map(role => ({
      name: role.name,
      scopes: role.scopes.filter(scope => (scope.kind === "office" && uuid.test(scope.id)) || (scope.kind === "governorate" && plainText(scope.id, roleLimits.governorate) && scope.id === scope.id.trim())).map(scope => ({ kind: scope.kind, id: scope.id })),
    })),
  };
}
/** هل تغيّر شيء بين الأدوار الحالية والمختارة؟ الترتيب لا يهم. */
export function sameRoles(a: readonly StaffRole[], b: readonly StaffRole[]): boolean {
  const key = (roles: readonly StaffRole[]) => roles.map(r => `${r.name}[${r.scopes.map(s => `${s.kind}:${s.id}`).sort().join(",")}]`).sort().join("|");
  return key(a) === key(b);
}
