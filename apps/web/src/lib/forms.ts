import type { Field, Form, MaterialType, Permission, Values } from "./types";
import { mayReadField } from "./privacy";
import { dateTime, uuid } from "./query";

export type ValidationCode = "required" | "type" | "min_length" | "max_length" | "pattern" | "min" | "max" | "option" | "min_items" | "max_items" | "not_before" | "not_after" | "accept" | "max_size_bytes";
export type ValidationResult = { valid: boolean; errors: { field: string; code: ValidationCode }[] };
const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function visibleFields(form: Form, type: MaterialType, values: Values, permissions: Permission[] = []): Field[] {
  const visible = new Set<string>();
  return form.fields.filter(field => {
    if (!mayReadField(field, permissions) || (field.material_types?.length && !field.material_types.includes(type))) return false;
    if (field.condition) {
      if (!visible.has(field.condition.field)) return false;
      const control: unknown = values[field.condition.field];
      if (!(Array.isArray(control) ? control.includes(field.condition.equals) : control === field.condition.equals)) return false;
    }
    visible.add(field.key); return true;
  });
}

function rule(field: Field, value: unknown): ValidationCode | null {
  if (empty(value)) return field.required ? "required" : null;
  const v = field.validation ?? {};
  switch (field.type) {
    case "short_text": case "long_text": {
      if (typeof value !== "string") return "type";
      const length = Array.from(value).length;
      if (v.min_length !== undefined && length < v.min_length) return "min_length";
      if (v.max_length !== undefined && length > v.max_length) return "max_length";
      if (v.pattern !== undefined) { try { if (!new RegExp(v.pattern, "u").test(value)) return "pattern"; } catch { return "pattern"; } }
      return null;
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "type";
      if (v.min !== undefined && value < v.min) return "min";
      if (v.max !== undefined && value > v.max) return "max";
      return null;
    case "select":
      if (typeof value !== "string") return "type";
      return v.options?.some(o => o.value === value) ? null : "option";
    case "multi_select":
      if (!Array.isArray(value) || value.some(x => typeof x !== "string")) return "type";
      if (v.min_items !== undefined && value.length < v.min_items) return "min_items";
      if (v.max_items !== undefined && value.length > v.max_items) return "max_items";
      return value.every(x => v.options?.some(o => o.value === x)) ? null : "option";
    case "boolean": return typeof value === "boolean" ? null : "type";
    case "datetime": {
      if (typeof value !== "string" || !dateTime.test(value) || !Number.isFinite(Date.parse(value))) return "type";
      const time = Date.parse(value);
      if (v.not_before && time < Date.parse(v.not_before)) return "not_before";
      if (v.not_after && time > Date.parse(v.not_after)) return "not_after";
      return null;
    }
    case "staff_member": return typeof value === "string" && uuid.test(value) ? null : "type";
    case "attachment": {
      if (!Array.isArray(value) || value.some(x => !x || typeof x !== "object" || typeof x.mime !== "string" || !Number.isInteger(x.size_bytes))) return "type";
      if (v.min_items !== undefined && value.length < v.min_items) return "min_items";
      if (v.max_items !== undefined && value.length > v.max_items) return "max_items";
      if (value.some(x => !v.accept?.some(a => a.endsWith("/*") ? x.mime.startsWith(a.slice(0, -1)) : a === x.mime))) return "accept";
      if (v.max_size_bytes !== undefined && value.some(x => x.size_bytes > v.max_size_bytes!)) return "max_size_bytes";
      return null;
    }
    // النوع محظور في v0؛ لا نفترض شكل قيمة لم يحدده العقد.
    case "location": return "type";
  }
}

export function validate(form: Form, type: MaterialType, values: Values, permissions: Permission[] = []): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  for (const field of visibleFields(form, type, values, permissions)) {
    const code = rule(field, values[field.key]);
    if (code) errors.push({ field: field.key, code });
  }
  return { valid: errors.length === 0, errors };
}
