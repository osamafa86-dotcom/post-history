import type { Field, Form, Material, Me, Permission, Values, Notification, TransitionRecord } from "./types";
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
