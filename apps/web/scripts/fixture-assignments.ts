// إسناد اصطناعي لخادم الاختبار (ADR 0096): مهام في الذاكرة بجدول انتقالات العقد، ومرشّحون بأسماء عمل تجريبية، وحزمة تصدير
// تجهز بعد ثانية ونصف. للاختبار والقياس المحلي فقط؛ لا يدخل حزمة التطبيق.
import { randomUUID } from "node:crypto";
import type { Material, Me } from "../src/lib/types";
import type { MaterialAssignment } from "../src/lib/assignment-policy";

export const editors = [
  { user_id: "10000000-0000-4000-8000-000000000001", work_name: "مونتير تجريبي ١" },
  { user_id: "10000000-0000-4000-8000-000000000003", work_name: "مونتير تجريبي ٢" },
  { user_id: "10000000-0000-4000-8000-000000000004", work_name: null },
];
const assignable = ["accepted", "in_production", "final_review", "published"], open = ["assigned", "acknowledged", "in_progress"];
const table: Record<string, string[]> = { assigned: ["acknowledged", "in_progress", "returned"], acknowledged: ["in_progress", "returned"], in_progress: ["done", "returned"], done: [], returned: [] };
const tasks: MaterialAssignment[] = [], exports = new Map<string, { state: string; readyAt: number; requested_at: string }>();
type Reply = { status: number; value: unknown } | null;
const iso = (at: number) => new Date(at).toISOString();
const view = (task: MaterialAssignment) => ({ ...task, overdue: open.includes(task.state) && Date.parse(task.due_at) < Date.now(), internal_debug: "never-display-canary" });

export function resetAssignments() { tasks.length = 0; exports.clear(); }

/** مهام لـ«مهامي»: متأخرة، وقريبة عاجلة، ولاحقة، ومسلّمة. */
export function seedAssignments(materials: Material[], me: Me) {
  resetAssignments();
  const now = Date.now(), make = (material: Material, state: MaterialAssignment["state"], due: number, note: string | null) => {
    material.editorial_state = "accepted";
    tasks.push({ id: randomUUID(), material_id: material.id, priority: material.priority, assignee_id: me.user_id, assignee_name: editors[0].work_name, assigned_by: "10000000-0000-4000-8000-000000000002", assigned_by_name: "محرر تجريبي ١",
      state, due_at: iso(due), overdue: false, note, returned_by: null, return_note: null, created_at: iso(now - 7200000), acknowledged_at: state === "assigned" ? null : iso(now - 3600000), started_at: state === "in_progress" || state === "done" ? iso(now - 3000000) : null,
      closed_at: state === "done" ? iso(now - 600000) : null, updated_at: iso(now - 600000) });
  };
  make(materials[6], "in_progress", now + 4 * 3600000, null);
  make(materials[4], "assigned", now + 18 * 60000, "تقرير عاجل 60 ثانية طولي، مع تمويه الوجوه");
  make(materials[8], "acknowledged", now - 3600000, null);
  make(materials[12], "done", now - 86400000, null);
  Object.assign(materials[8], { sensitivity: { minors: true, injured: false, graphic: false } });
  materials[4].files = [...materials[4].files.filter(file => file.kind !== "original"),
    { id: "51000000-0000-4000-8000-000000000001", kind: "original", state: "verified", mime_type: "video/mp4", size_bytes: 420_000_000, duration_ms: 102_000, created_at: iso(now) },
    { id: "51000000-0000-4000-8000-000000000002", kind: "original", state: "verified", mime_type: "video/mp4", size_bytes: 610_000_000, duration_ms: 185_000, created_at: iso(now) },
    { id: "51000000-0000-4000-8000-000000000003", kind: "original", state: "verified", mime_type: "image/jpeg", size_bytes: 6_000_000, created_at: iso(now) }];
}

export function assignmentWrite(path: string, user: Me, body: Record<string, unknown>, materials: Material[]): Reply {
  const has = (...roles: string[]) => user.roles.some(role => roles.includes(role.name));
  const assign = /^\/v1\/materials\/([^/]+)\/assignments$/.exec(path);
  if (assign) {
    if (!has("supervisor", "editor_in_chief")) return { status: 403, value: { code: "forbidden_role" } };
    const material = materials.find(m => m.id === assign[1]); if (!material) return { status: 404, value: { code: "not_found" } };
    if (!assignable.includes(material.editorial_state)) return { status: 409, value: { code: "assignment_not_allowed", message: "never-display-canary", details: { failed: ["editorial_state"] } } };
    const editor = editors.find(e => e.user_id === body.assignee_id); if (!editor) return { status: 422, value: { code: "assignee_not_eligible" } };
    const current = tasks.find(t => t.material_id === material.id && open.includes(t.state));
    if (current) return { status: 409, value: { code: "assignment_open", details: { assignment_id: current.id } } };
    const stamp = new Date().toISOString(), task: MaterialAssignment = { id: randomUUID(), material_id: material.id, priority: material.priority, assignee_id: editor.user_id, assignee_name: editor.work_name, assigned_by: user.user_id, assigned_by_name: "محرر تجريبي ١",
      state: "assigned", due_at: String(body.due_at), overdue: false, note: typeof body.note === "string" ? body.note : null, returned_by: null, return_note: null, created_at: stamp, acknowledged_at: null, started_at: null, closed_at: null, updated_at: stamp };
    tasks.unshift(task); return { status: 201, value: view(task) };
  }
  const move = /^\/v1\/assignments\/([^/]+)\/transitions$/.exec(path);
  if (move) {
    const task = tasks.find(t => t.id === move[1]); if (!task) return { status: 404, value: { code: "not_found" } };
    const to = String(body.to);
    if (!table[task.state].includes(to)) return { status: 409, value: { code: "invalid_transition", details: { from: task.state, to } } };
    if (task.assignee_id !== user.user_id && !(to === "returned" && has("supervisor", "editor_in_chief"))) return { status: 403, value: { code: "forbidden_scope" } };
    const stamp = new Date().toISOString();
    Object.assign(task, { state: to, updated_at: stamp, ...(to === "acknowledged" || (to === "in_progress" && !task.acknowledged_at) ? { acknowledged_at: stamp } : {}), ...(to === "in_progress" ? { started_at: stamp } : {}),
      ...(to === "done" || to === "returned" ? { closed_at: stamp } : {}), ...(to === "returned" ? { returned_by: user.user_id, return_note: typeof body.note === "string" ? body.note : null } : {}) });
    return { status: 200, value: view(task) };
  }
  const exporting = /^\/v1\/materials\/([^/]+)\/export$/.exec(path);
  if (exporting) {
    if (!has("producer", "editor_in_chief", "rights_officer", "system_admin")) return { status: 403, value: {} };
    const now = Date.now(), current = exports.get(exporting[1]);
    if (current && current.state !== "failed") return { status: 200, value: exportView(exporting[1]) };
    exports.set(exporting[1], { state: "requested", readyAt: now + 1500, requested_at: iso(now) }); return { status: 202, value: exportView(exporting[1]) };
  }
  return null;
}

function exportView(materialId: string) {
  const current = exports.get(materialId), ready = !!current && Date.now() >= current.readyAt;
  return { state: !current ? "none" : ready ? "ready" : current.state, source_file_id: "50000000-0000-4000-8000-000000000001", file_id: ready ? "52000000-0000-4000-8000-000000000001" : null, requested_by: current ? "never-display-canary" : null, requested_at: current?.requested_at ?? null, failure_reason: null };
}

export function assignmentRead(url: URL, user: Me, sign: () => string): Reply {
  const has = (...roles: string[]) => user.roles.some(role => roles.includes(role.name)), path = url.pathname;
  if (path === "/v1/assignment-candidates") {
    if (!has("supervisor", "editor_in_chief")) return { status: 403, value: {} };
    return { status: 200, value: { items: editors.map((e, i) => { const mine = tasks.filter(t => t.assignee_id === e.user_id && open.includes(t.state)); return { ...e, open_count: mine.length + (i === 1 ? 3 : 0), urgent_open_count: mine.filter(t => t.priority === "urgent").length + (i === 1 ? 1 : 0), overdue_count: mine.filter(t => Date.parse(t.due_at) < Date.now()).length, email: "never-display-canary@example.test" }; }).sort((a, b) => a.open_count - b.open_count) } };
  }
  if (path === "/v1/me/assignments") {
    if (!has("producer")) return { status: 403, value: {} };
    const closed = url.searchParams.get("status") === "closed", mine = tasks.filter(t => t.assignee_id === user.user_id), week = Date.now() - 7 * 86400000;
    const items = mine.filter(t => open.includes(t.state) !== closed).map(view).sort((a, b) => closed ? Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? "") : Date.parse(a.due_at) - Date.parse(b.due_at));
    return { status: 200, value: { items, next_cursor: null, summary: { active: mine.filter(t => open.includes(t.state)).length, overdue: mine.map(view).filter(t => t.overdue).length, done_last_7_days: mine.filter(t => t.state === "done" && Date.parse(t.closed_at ?? "") >= week).length } } };
  }
  const one = /^\/v1\/assignments\/([^/]+)$/.exec(path);
  if (one) { const task = tasks.find(t => t.id === one[1]); return task ? { status: 200, value: view(task) } : { status: 404, value: { code: "not_found" } }; }
  const list = /^\/v1\/materials\/([^/]+)\/assignments$/.exec(path);
  if (list) return { status: 200, value: { items: tasks.filter(t => t.material_id === list[1]).map(view) } };
  const exporting = /^\/v1\/materials\/([^/]+)\/export(\/download-url)?$/.exec(path);
  if (exporting) {
    if (!has("producer", "editor_in_chief", "rights_officer", "system_admin")) return { status: 403, value: {} };
    if (!exporting[2]) return { status: 200, value: exportView(exporting[1]) };
    if (exportView(exporting[1]).state !== "ready") return { status: 409, value: { code: "export_not_ready" } };
    return { status: 200, value: { url: sign(), expires_at: iso(Date.now() + 300000) } };
  }
  return null;
}
