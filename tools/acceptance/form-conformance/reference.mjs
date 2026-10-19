// Reference implementation of the shared form validation rules (see README.md "Semantics").
// It exists to prove the cases are self-consistent; web, iOS and Android each implement the same rules
// natively and are judged by the same cases.json, never by this file.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const codePoints = (s) => [...s].length;
const instant = (s) => (RFC3339.test(s) && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);

function mimeAccepted(mime, accept) {
  return accept.some((a) => (a.endsWith("/*") ? mime.startsWith(a.slice(0, -1)) : a === mime));
}

/** Returns the first failing rule code for one visible field, or null. */
function checkField(field, v) {
  const val = field.validation ?? {};
  if (isEmpty(v)) return field.required ? "required" : null;
  switch (field.type) {
    case "short_text":
    case "long_text": {
      if (typeof v !== "string") return "type";
      const n = codePoints(v);
      if (val.min_length !== undefined && n < val.min_length) return "min_length";
      if (val.max_length !== undefined && n > val.max_length) return "max_length";
      if (val.pattern !== undefined && !new RegExp(val.pattern, "u").test(v)) return "pattern";
      return null;
    }
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return "type";
      if (val.min !== undefined && v < val.min) return "min";
      if (val.max !== undefined && v > val.max) return "max";
      return null;
    case "select":
      if (typeof v !== "string") return "type";
      return val.options.some((o) => o.value === v) ? null : "option";
    case "multi_select":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return "type";
      if (val.min_items !== undefined && v.length < val.min_items) return "min_items";
      if (val.max_items !== undefined && v.length > val.max_items) return "max_items";
      return v.every((x) => val.options.some((o) => o.value === x)) ? null : "option";
    case "datetime": {
      if (typeof v !== "string") return "type";
      const t = instant(v);
      if (t === null) return "type";
      if (val.not_before !== undefined && t < Date.parse(val.not_before)) return "not_before";
      if (val.not_after !== undefined && t > Date.parse(val.not_after)) return "not_after";
      return null;
    }
    case "boolean":
      return typeof v === "boolean" ? null : "type";
    case "staff_member":
      return typeof v === "string" && UUID.test(v) ? null : "type";
    case "attachment": {
      if (!Array.isArray(v) || v.some((x) => typeof x?.mime !== "string" || !Number.isInteger(x?.size_bytes))) return "type";
      if (val.min_items !== undefined && v.length < val.min_items) return "min_items";
      if (val.max_items !== undefined && v.length > val.max_items) return "max_items";
      if (v.some((x) => !mimeAccepted(x.mime, val.accept))) return "accept";
      if (v.some((x) => x.size_bytes > val.max_size_bytes)) return "max_size_bytes";
      return null;
    }
    default:
      return "type";
  }
}

function visibleKeys(form, materialType, values) {
  const visible = new Set();
  for (const f of form.fields) {
    if (f.material_types?.length && !f.material_types.includes(materialType)) continue;
    if (f.condition) {
      if (!visible.has(f.condition.field)) continue; // a hidden controller hides what depends on it
      const cv = values[f.condition.field];
      const met = Array.isArray(cv) ? cv.includes(f.condition.equals) : cv === f.condition.equals;
      if (!met) continue;
    }
    visible.add(f.key);
  }
  return visible;
}

/** @returns {{valid: boolean, errors: {field: string, code: string}[]}} errors in form field order, one per field */
export function validate(form, materialType, values) {
  const visible = visibleKeys(form, materialType, values);
  const errors = [];
  for (const f of form.fields) {
    if (!visible.has(f.key)) continue;
    const code = checkField(f, values[f.key]);
    if (code) errors.push({ field: f.key, code });
  }
  return { valid: errors.length === 0, errors };
}
