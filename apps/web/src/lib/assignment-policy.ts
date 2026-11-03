import type { components } from "@/generated/schema";
import type { Material, Me, RoleName } from "./types";
import { hasRole } from "./review";
import { workName } from "./work-name";
import { dateTime, uuid } from "./query";
import { titleLinePattern } from "./render-policy";

export type MaterialAssignment = components["schemas"]["MaterialAssignment"];
export type AssignmentState = components["schemas"]["MaterialAssignmentState"];
export type AssignmentCandidate = components["schemas"]["AssignmentCandidate"];
export type MyAssignmentPage = components["schemas"]["MyAssignmentPage"];
export type AssignmentCreate = components["schemas"]["MaterialAssignmentCreate"];
export type AssignmentTransition = components["schemas"]["AssignmentTransition"];
export type MaterialExport = components["schemas"]["MaterialExport"];

/**
 * إسناد المادة إلى المونتير و«مهامي» في الويب (ADR 0096، ADR 0097؛ web-v2.md W3 وW5–W6 وM3). القيم من العقد، واختبار
 * التطابق (`contract-drift.test.ts`) يقارنها به.
 */
export const assignRoles = ["supervisor", "editor_in_chief"] as const satisfies readonly RoleName[];
export const taskReaders = ["supervisor", "producer", "editor_in_chief", "system_admin"] as const satisfies readonly RoleName[];
export const transitionRoles = ["supervisor", "producer", "editor_in_chief"] as const satisfies readonly RoleName[];
export const myTaskRoles = ["producer"] as const satisfies readonly RoleName[];
/** حزمة التصدير («الرشزات»): بأدوار تنزيل الأصل في العقد، فالمشرف لا ينزّلها. */
export const exportRoles = ["producer", "editor_in_chief", "rights_officer", "system_admin"] as const satisfies readonly RoleName[];
export const assignmentStates = ["assigned", "acknowledged", "in_progress", "done", "returned"] as const satisfies readonly AssignmentState[];
export const openStates = ["assigned", "acknowledged", "in_progress"] as const satisfies readonly AssignmentState[];
export const transitionTargets = ["acknowledged", "in_progress", "done", "returned"] as const satisfies readonly AssignmentTransition["to"][];
export const myTaskStatuses = ["active", "closed"] as const;
export const exportStates = ["none", "requested", "ready", "failed"] as const satisfies readonly MaterialExport["state"][];
/** ما يراه الإنتاج من الحالات التحريرية، وشرط الإسناد في الخادم (`409 assignment_not_allowed` لغيره). */
export const assignableStates = ["accepted", "in_production", "final_review", "published"] as const satisfies readonly Material["editorial_state"][];
export const noteMax = 500, maxDueDays = 30, taskPageLimit = 20, candidatesMax = 200;
/** قاعدة `AssignmentNote` في العقد هي قاعدة `MaterialTag` نفسها، فالنمط واحد (`titleLinePattern`). */
export const notePattern = titleLinePattern;
const noteRule = new RegExp(notePattern, "u"), forbidden = /[\u0000-\u001F\u007F-\u009F\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
export const cleanNote = (value: string) => value.replace(forbidden, "");
export const validNote = (value: unknown): value is string => typeof value === "string" && Array.from(value).length <= noteMax && noteRule.test(value);
/** وجهة الإشعار: مهمته إن حمل `assignment_id` (W6)، وإلا مادته، وإلا لا شيء. */
export const notificationTarget = (n: { assignment_id?: string | null; material_id?: string | null }, locale: string) =>
  n.assignment_id && uuid.test(n.assignment_id) ? `/${locale}/tasks/${n.assignment_id}` : n.material_id && uuid.test(n.material_id) ? `/${locale}/materials/${n.material_id}` : null;
export const isOpen = (state: string) => (openStates as readonly string[]).includes(state);

/**
 * جدول انتقالات المهمة كما في العقد: المسنَد إليه يتقدّم بها ويعيدها، ومن يملك الإسناد (المشرف في نطاقه ورئيس التحرير) يعيدها وحسب.
 * نطاق المشرف لا يعرفه الويب، فالدور يكفي هنا والخادم يحكم (`403 forbidden_scope`).
 */
const table: Record<AssignmentState, { to: AssignmentTransition["to"]; manager: boolean }[]> = {
  assigned: [{ to: "acknowledged", manager: false }, { to: "in_progress", manager: false }, { to: "returned", manager: true }],
  acknowledged: [{ to: "in_progress", manager: false }, { to: "returned", manager: true }],
  in_progress: [{ to: "done", manager: false }, { to: "returned", manager: true }],
  done: [], returned: [],
};
export function nextStates(task: Pick<MaterialAssignment, "state" | "assignee_id">, me: Me): AssignmentTransition["to"][] {
  const assignee = task.assignee_id === me.user_id, manager = hasRole(me, ...assignRoles);
  return (table[task.state] ?? []).filter(step => assignee || (step.manager && manager)).map(step => step.to);
}
export const canAssign = (me: Me, material: Pick<Material, "editorial_state">) => hasRole(me, ...assignRoles) && (assignableStates as readonly string[]).includes(material.editorial_state);

/** خيارات «المطلوب خلال» في W3: الموعد يحسبه العميل (العقد يقبل `due_at` وحده). «اليوم» نهاية اليوم المحلي، ويختفي إن بقي أقل من 30 دقيقة. */
export const duePresets = ["30m", "1h", "today"] as const;
export type DuePreset = (typeof duePresets)[number];
export function dueAt(preset: DuePreset, now: number): string | null {
  if (preset === "30m") return new Date(now + 30 * 60000).toISOString();
  if (preset === "1h") return new Date(now + 60 * 60000).toISOString();
  const end = new Date(now); end.setHours(23, 59, 0, 0);
  return end.getTime() - now >= 30 * 60000 ? end.toISOString() : null;
}

/** «مهامي»: المتأخر أولًا ثم الأقرب موعدًا (الخادم يرتّب بالموعد، والمتأخر موعده أقدم فيسبق؛ الترتيب هنا لما يُدمج من الصفحات). */
export const taskOrder = <T extends Pick<MaterialAssignment, "due_at" | "overdue" | "id">>(items: readonly T[]) =>
  [...items].sort((a, b) => Number(b.overdue) - Number(a.overdue) || Date.parse(a.due_at) - Date.parse(b.due_at) || a.id.localeCompare(b.id));

/** الموعد كما يُقرأ في W5 وM3: «متأخرة {مدة}» أو «خلال {مدة}» في الساعات الست القادمة أو «اليوم HH:MM» أو التاريخ. */
export function dueLabel(task: Pick<MaterialAssignment, "due_at" | "overdue" | "state">, now: number): { kind: "overdue" | "soon" | "today" | "later" | "closed"; ms: number; at: string } {
  const due = Date.parse(task.due_at), ms = due - now;
  if (!isOpen(task.state)) return { kind: "closed", ms, at: task.due_at };
  if (task.overdue || ms < 0) return { kind: "overdue", ms: Math.abs(ms), at: task.due_at };
  if (ms <= 6 * 3600000) return { kind: "soon", ms, at: task.due_at };
  return { kind: new Date(due).toDateString() === new Date(now).toDateString() ? "today" : "later", ms, at: task.due_at };
}

/** حِمل المرشّح في W3: «متاح الآن» أو عدد مهامه المفتوحة ومنها العاجل والمتأخر. «خارج المناوبة» لا مقابل له في العقد. */
export const candidateLoad = (c: Pick<AssignmentCandidate, "open_count" | "urgent_open_count" | "overdue_count">) => ({ free: c.open_count === 0, open: c.open_count, urgent: c.urgent_open_count, overdue: c.overdue_count });

const time = (value: unknown) => typeof value === "string" && dateTime.test(value) && Number.isFinite(Date.parse(value));
const optional = <T>(value: unknown, test: (v: unknown) => boolean) => (value === null || value === undefined ? null : test(value) ? value as T : undefined);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);

/** المهمة بقائمة بيضاء؛ وما خالف العقد يُسقطها كلها (فشل مغلق). الاسمان لمن يرى أسماء العمل وحده، كما في `safeMaterial`. */
export function safeAssignment(item: MaterialAssignment, internal: boolean): MaterialAssignment | null {
  const note = optional<string>(item.note, validNote), returnNote = optional<string>(item.return_note, validNote), returnedBy = optional<string>(item.returned_by, isId);
  const acknowledged = optional<string>(item.acknowledged_at, time), started = optional<string>(item.started_at, time), closed = optional<string>(item.closed_at, time);
  if (![item.id, item.material_id, item.assignee_id, item.assigned_by].every(isId) || !(assignmentStates as readonly string[]).includes(item.state) || !["urgent", "important", "normal"].includes(item.priority)
    || typeof item.overdue !== "boolean" || ![item.due_at, item.created_at, item.updated_at].every(time) || [note, returnNote, returnedBy, acknowledged, started, closed].includes(undefined)) return null;
  return { id: item.id, material_id: item.material_id, priority: item.priority, assignee_id: item.assignee_id, assigned_by: item.assigned_by,
    ...(internal ? { assignee_name: workName(item.assignee_name), assigned_by_name: workName(item.assigned_by_name) } : {}),
    state: item.state, due_at: item.due_at, overdue: item.overdue, note: note ?? null, returned_by: returnedBy ?? null, return_note: returnNote ?? null,
    created_at: item.created_at, acknowledged_at: acknowledged ?? null, started_at: started ?? null, closed_at: closed ?? null, updated_at: item.updated_at };
}
export function safeCandidate(item: AssignmentCandidate): AssignmentCandidate | null {
  if (!isId(item.user_id) || ![item.open_count, item.urgent_open_count, item.overdue_count].every(count)) return null;
  return { user_id: item.user_id, work_name: workName(item.work_name), open_count: item.open_count, urgent_open_count: item.urgent_open_count, overdue_count: item.overdue_count };
}
export function safeMyPage(page: MyAssignmentPage, internal: boolean): MyAssignmentPage {
  const s = page.summary ?? { active: 0, overdue: 0, done_last_7_days: 0 };
  return { items: page.items.map(item => safeAssignment(item, internal)).filter(item => item !== null), next_cursor: typeof page.next_cursor === "string" && page.next_cursor.length <= 2048 ? page.next_cursor : null,
    summary: { active: count(s.active) ? s.active : 0, overdue: count(s.overdue) ? s.overdue : 0, done_last_7_days: count(s.done_last_7_days) ? s.done_last_7_days : 0 } };
}
export function safeExport(item: MaterialExport): MaterialExport | null {
  const source = optional<string>(item.source_file_id, isId), file = optional<string>(item.file_id, isId), requested = optional<string>(item.requested_at, time);
  const reason = optional<MaterialExport["failure_reason"]>(item.failure_reason, v => v === "source_unavailable" || v === "build_failed");
  if (!(exportStates as readonly string[]).includes(item.state) || [source, file, requested, reason].includes(undefined)) return null;
  return { state: item.state, source_file_id: source ?? null, file_id: file ?? null, requested_at: requested ?? null, failure_reason: reason ?? null };
}

/** جسم الإسناد في الـBFF: المفاتيح الثلاثة وحدها، والموعد بعد الآن وفي 30 يومًا، والملاحظة بقاعدة العقد؛ ويُعاد بناؤه منها. */
export function assignmentInput(body: Record<string, unknown>, now = Date.now()): AssignmentCreate | null {
  if (Object.keys(body).some(key => !["assignee_id", "due_at", "note"].includes(key)) || !isId(body.assignee_id) || !time(body.due_at)) return null;
  const due = Date.parse(body.due_at as string);
  if (due <= now || due - now > maxDueDays * 86400000 || (body.note !== undefined && !validNote(body.note))) return null;
  return { assignee_id: body.assignee_id, due_at: body.due_at as string, ...(body.note !== undefined ? { note: body.note as string } : {}) };
}
/** جسم الانتقال: `to` من القائمة، والملاحظة مع `returned` وحدها. */
export function transitionInput(body: Record<string, unknown>): AssignmentTransition | null {
  if (Object.keys(body).some(key => !["to", "note"].includes(key)) || !(transitionTargets as readonly unknown[]).includes(body.to)) return null;
  if (body.note !== undefined && (body.to !== "returned" || !validNote(body.note))) return null;
  return { to: body.to as AssignmentTransition["to"], ...(body.note !== undefined ? { note: body.note as string } : {}) };
}

/** تفاصيل رموز الإسناد الآلية وحدها: الشرط الفاشل من قائمته، ومعرّف المهمة المفتوحة، وحالتا الانتقال المرفوض. */
export function assignmentDetails(code: string, value: unknown): Record<string, unknown> | undefined {
  const details = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (code === "assignment_not_allowed") return { failed: Array.isArray(details.failed) && details.failed.includes("editorial_state") ? ["editorial_state"] : [] };
  if (code === "assignment_open") return isId(details.assignment_id) ? { assignment_id: details.assignment_id } : {};
  if (code === "invalid_transition") {
    const state = (v: unknown) => (assignmentStates as readonly unknown[]).includes(v);
    return state(details.from) && state(details.to) ? { from: details.from, to: details.to } : {};
  }
  return undefined;
}

/** مدة المقطع «2:14» أو «1:02:03»، أرقام لاتينية؛ بلا مدة لا شيء. */
export function mediaDuration(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60, pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
/** الحجم «412 MB» و«1.2 GB» بقوى 1000 كما في الإطارات؛ أرقام لاتينية. */
export function byteSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${unit && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
/** رشزات المادة: أصولها كما في `Material.files`. لا رابط لكل أصل في العقد، فالتنزيل بحزمة التصدير. */
export function rushes(material: Pick<Material, "files">) {
  const files = material.files.filter(file => file.kind === "original"), sized = files.filter(file => typeof file.size_bytes === "number" && Number.isSafeInteger(file.size_bytes));
  return { files, count: files.length, size: sized.length ? sized.reduce((sum, file) => sum + file.size_bytes!, 0) : null };
}
