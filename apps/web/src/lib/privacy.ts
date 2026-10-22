import type { Field, Form, Material, Me, Permission, Values, Notification, TransitionRecord, NewsroomDashboard } from "./types";
import { uuid, states } from "./query";

export function mayReadField(field: Field, permissions: Permission[]) {
  return (!field.sensitive || permissions.includes("protected_source:read")) &&
    (field.type !== "location" || permissions.includes("sensitive_location:read"));
}
export function redactValues(values: Values, form: Form | undefined, permissions: Permission[], redacted: string[] = []): Values {
  const allowed = form?.fields.filter(f => mayReadField(f, permissions) && !redacted.includes(f.key)).map(f => f.key) ?? [];
  return Object.fromEntries(allowed.filter(k => Object.hasOwn(values, k)).map(k => [k, values[k]]));
}
export function safeMe(me: Me): Me {
  return { user_id: me.user_id, email: me.email, roles: me.roles, permissions: me.permissions, totp_enabled: me.totp_enabled };
}
export function safeForm<T extends Form>(form: T, permissions: Permission[]): T {
  return { ...form, fields: form.fields.filter(field => mayReadField(field, permissions)) };
}
export function safeMaterial(material: Material, permissions: Permission[], form?: Form): Material {
  // قائمة بيضاء تمنع انتقال حقول جديدة غير مراجعة إلى المتصفح؛ GPS writeOnly في العقد الحالي.
  return {
    id: material.id, version: material.version, row_version: material.row_version, reporter_id: material.reporter_id, office_id: material.office_id,
    reserved_by: material.reserved_by, reserved_at: material.reserved_at,
    contributors: material.contributors?.map(({ user_id, role, share_percent }) => ({ user_id, role, share_percent })),
    title: material.title, material_types: material.material_types, governorate: material.governorate, city: material.city,
    shot_at: material.shot_at, priority: material.priority,
    sensitivity: { minors: material.sensitivity.minors, injured: material.sensitivity.injured, graphic: material.sensitivity.graphic },
    display_name: { mode: material.display_name.mode, pseudonym: material.display_name.mode === "pseudonym" ? material.display_name.pseudonym : null },
    form_version: material.form_version, dynamic_fields: redactValues(material.dynamic_fields, form, permissions, material.redacted_field_keys),
    technical_state: material.technical_state, editorial_state: material.editorial_state, rights_state: material.rights_state,
    created_at: material.created_at, updated_at: material.updated_at,
    files: material.files.map(f => ({ id: f.id, kind: f.kind, state: f.state, mime_type: f.mime_type, duration_ms: f.duration_ms,
      width: f.width, height: f.height, receipt_number: f.receipt_number, created_at: f.created_at, verified_at: f.verified_at })),
    redacted_field_keys: material.redacted_field_keys ?? [],
  };
}
export function safeNotification(item: Notification): Notification {
  return { id: item.id, type: "", title: "", material_id: item.material_id && uuid.test(item.material_id) ? item.material_id : null,
    priority: item.priority, state: item.state, escalation_level: item.escalation_level, assignment_state: item.assignment_state,
    created_at: item.created_at, read_at: item.read_at, acknowledged_at: item.acknowledged_at };
}
export function safeTransition(item: TransitionRecord): TransitionRecord {
  const targets = states[`${item.track}_state`] as readonly string[] | undefined;
  return { id: item.id, track: item.track, from: targets?.includes(item.from) ? item.from : "", to: targets?.includes(item.to) ? item.to : "",
    actor_id: item.actor_id && uuid.test(item.actor_id) ? item.actor_id : null, occurred_at: item.occurred_at, reason: "" };
}

/** ما يصل المراسل من ملاحظة المشرف على مادته: سبب طلب التعديل أو الرفض وتوقيته، ولا سبب غيرهما. */
export const reporterNoteStates = ["needs_changes", "rejected"] as const;
export function reporterNote(item: TransitionRecord): TransitionRecord {
  const safe = safeTransition(item);
  if (safe.track !== "editorial" || !(reporterNoteStates as readonly string[]).includes(safe.to)) return safe;
  const reason = typeof item.reason === "string" ? Array.from(item.reason.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")).slice(0, 2000).join("") : "";
  const timecode = Number.isSafeInteger(item.note_timecode_ms) && Number(item.note_timecode_ms) >= 0 ? item.note_timecode_ms : null;
  return { ...safe, reason, note_timecode_ms: timecode };
}

/** لقطة غرفة الأخبار بقائمة بيضاء: معرّفات وأرقام وحالات فقط، والحالات من قوائم العقد وحدها. */
export function safeDashboard(d: NewsroomDashboard): NewsroomDashboard {
  const counts = (items: NewsroomDashboard["editorial"], allowed: readonly string[]) => items.filter(i => allowed.includes(i.state) && Number.isSafeInteger(i.count)).map(({ state, count }) => ({ state, count }));
  return {
    generated_at: d.generated_at, urgent_open: d.urgent_open, overdue_acknowledgements: d.overdue_acknowledgements,
    editorial: counts(d.editorial, states.editorial_state), technical: counts(d.technical, states.technical_state), rights: counts(d.rights, states.rights_state),
    reserved: d.reserved.filter(r => uuid.test(r.material_id)).map(({ material_id, reserved_by, reserved_at, priority, editorial_state }) => ({ material_id, reserved_by, reserved_at, priority, editorial_state })),
    recent_receipts: d.recent_receipts.filter(r => uuid.test(r.material_id)).map(({ material_id, receipt_number, verified_at, priority }) => ({ material_id, receipt_number, verified_at, priority })),
    // «الوارد الآن» (ADR 0024): معرّفات وأرقام وحدها، ولا اسم ملف ولا مراسل ولا جهاز حتى لو أرسلها الخادم.
    ...(d.uploads_in_progress ? { uploads_in_progress: d.uploads_in_progress.filter(u => uuid.test(u.upload_session_id) && uuid.test(u.material_id) && Number.isSafeInteger(u.size_bytes) && Number.isSafeInteger(u.bytes_received)).map(({ upload_session_id, material_id, kind, priority, state, size_bytes, bytes_received, updated_at }) => ({ upload_session_id, material_id, kind, priority, state, size_bytes, bytes_received: Math.min(bytes_received, size_bytes), updated_at })) } : {}),
  };
}
