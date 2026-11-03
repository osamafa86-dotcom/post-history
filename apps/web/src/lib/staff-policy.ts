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
