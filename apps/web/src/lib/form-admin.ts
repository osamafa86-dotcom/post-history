import validateSchema from "@/generated/form-validator.cjs";
import type { components, operations } from "@/generated/schema";
import type { Field, Form, RoleName } from "./types";
export { fieldTypes } from "@/generated/form-field-types";
export type FormSummary = components["schemas"]["FormVersionSummary"];
export type PublishForm = operations["publishForm"]["requestBody"]["content"]["application/json"];
export const formReaders = ["system_admin", "editor_in_chief"] as const satisfies readonly RoleName[];
export const formWriters = ["system_admin"] as const satisfies readonly RoleName[];
// حد خاص بلقطة النموذج، دون توسيع حد إجراءات المراجعة؛ أقل من حد API الافتراضي.
export const formBodyLimit = 64 * 1024;

export function validForm(value: unknown): value is Form {
  if (!validateSchema(value)) return false;
  const form = value as Form;
  if (!Number.isSafeInteger(form.version) || form.version > 999999999) return false;
  const keys = form.fields.map(f => f.key);
  return new Set(keys).size === keys.length && form.fields.every(f =>
    !f.condition || f.condition.field !== f.key && keys.includes(f.condition.field));
}

// لا تُنقل معلومات الناشر إلى طلب جديد. النسخة المنشورة لا تُعدّل بأي مرجع مشترك.
export function nextForm(source: Form | null, current: number): Form {
  return structuredClone({ version: current + 1, ...(source?.material_types ? { material_types: source.material_types } : {}), fields: source?.fields ?? [] });
}
export function publishBody(form: Form): PublishForm {
  // $defs كلمة JSON Schema أضافها مولّد الأنواع وليست خاصية بيانات (ADR 0014).
  return nextForm(form, form.version - 1) as PublishForm;
}
export function newField(type: Field["type"], key: string): Field {
  return { key, type, label: { ar: "", en: "" }, required: false, sensitive: false, searchable: false,
    ...(["select", "multi_select"].includes(type) ? { validation: { options: [{ value: "option_1", label: { ar: "", en: "" } }] } } : {}),
    ...(type === "attachment" ? { validation: { accept: ["application/pdf"], max_size_bytes: 10485760 } } : {}) };
}

export function safeFormSummary(value: FormSummary): FormSummary {
  if (!Number.isSafeInteger(value.version) || value.version < 1 || value.version > 999999999 || !Number.isInteger(value.field_count) || value.field_count < 0 || !Number.isFinite(Date.parse(value.published_at))) throw new Error("Invalid form summary");
  return { version: value.version, field_count: value.field_count, published_at: value.published_at, ...(typeof value.is_current === "boolean" ? { is_current: value.is_current } : {}) };
}
