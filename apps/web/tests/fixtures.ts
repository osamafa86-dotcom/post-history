import { readFileSync } from "node:fs";
import type { Form, Material, Me, Session } from "../src/lib/types";
import type { MaterialAssignment } from "../src/lib/assignment-policy";
export const me: Me = { user_id: "10000000-0000-4000-8000-000000000001", email: "fixture@example.test", roles: [], permissions: [], totp_enabled: true };
export const tokens = (): Session => ({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", user_id: me.user_id, roles: [], expires_at: new Date(Date.now() + 600000).toISOString() });
export const form = JSON.parse(readFileSync(new URL("../../../tools/acceptance/form-conformance/forms/main.json", import.meta.url), "utf8")) as Form;
export function material(index = 1): Material {
  return {
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: 1, reporter_id: me.user_id, office_id: null,
    title: `مادة اختبار اصطناعية ${String(index).padStart(3, "0")}`, material_types: ["report"], governorate: index % 2 ? "غزة" : "القدس", city: "مدينة اختبار",
    shot_at: new Date(Date.UTC(2026, 9, 19, 12, 0, index)).toISOString(), priority: index % 5 === 0 ? "urgent" : "normal",
    sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" }, form_version: form.version,
    dynamic_fields: {}, technical_state: "verified", editorial_state: "inbox", rights_state: "unknown",
    files: [
      { id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "proxy", state: "verified", mime_type: "video/mp4", receipt_number: `RCPT-20261020-${String(index).padStart(6, "0")}`, created_at: "2026-10-19T12:00:00Z" },
      { id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "thumbnail", state: "verified", mime_type: "image/png", created_at: "2026-10-19T12:00:00Z" },
      { id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`, kind: "original", state: "verified", mime_type: "video/mp4", created_at: "2026-10-19T12:00:00Z" },
    ],
    created_at: "2026-10-19T12:00:00Z", updated_at: "2026-10-19T12:00:00Z", redacted_field_keys: [],
  };
}
export const assignmentIds = { task: "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c", material: "7b4a1f6e-3c2d-4e8f-9a1b-2c3d4e5f6a7b", producer: "2f3e4d5c-6b7a-4899-8a7b-6c5d4e3f2a1b", supervisor: "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d" };
export const task = (patch: Partial<MaterialAssignment> = {}): MaterialAssignment => ({ id: assignmentIds.task, material_id: assignmentIds.material, priority: "urgent", assignee_id: assignmentIds.producer, assignee_name: "مونتير تجريبي ١", assigned_by: assignmentIds.supervisor, assigned_by_name: "محرر تجريبي ١",
  state: "assigned", due_at: "2026-11-03T15:00:00Z", overdue: false, note: "ملاحظة تجريبية", returned_by: null, return_note: null, created_at: "2026-11-03T14:30:00Z", acknowledged_at: null, started_at: null, closed_at: null, updated_at: "2026-11-03T14:30:00Z", ...patch });
