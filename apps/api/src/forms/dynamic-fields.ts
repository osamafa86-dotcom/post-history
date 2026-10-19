import type { components } from '../generated/api';

export type UploadForm = components['schemas']['UploadForm'];
type Field = UploadForm['fields'][number];

export interface FieldError {
  field: string;
  code: string;
}

// قواعد التحقق المشتركة بين الواجهات الثلاث والخادم (tools/acceptance/form-conformance/README.md، «الدلالات»).
// يُحكم عليها بـ cases.json في اختبارات الوحدة؛ أي اختلاف هنا اختلاف بين المنصات.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const codePoints = (s: string) => [...s].length;
const instant = (s: string) => (RFC3339.test(s) && !Number.isNaN(Date.parse(s)) ? Date.parse(s) : null);
const mimeAccepted = (mime: string, accept: string[]) =>
  accept.some((a) => (a.endsWith('/*') ? mime.startsWith(a.slice(0, -1)) : a === mime));

function checkField(field: Field, v: unknown): string | null {
  const val = field.validation ?? {};
  if (isEmpty(v)) return field.required ? 'required' : null;
  switch (field.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof v !== 'string') return 'type';
      const n = codePoints(v);
      if (val.min_length !== undefined && n < val.min_length) return 'min_length';
      if (val.max_length !== undefined && n > val.max_length) return 'max_length';
      if (val.pattern !== undefined && !new RegExp(val.pattern, 'u').test(v)) return 'pattern';
      return null;
    }
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'type';
      if (val.min !== undefined && v < val.min) return 'min';
      if (val.max !== undefined && v > val.max) return 'max';
      return null;
    case 'select':
      if (typeof v !== 'string') return 'type';
      return (val.options ?? []).some((o) => o.value === v) ? null : 'option';
    case 'multi_select':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return 'type';
      if (val.min_items !== undefined && v.length < val.min_items) return 'min_items';
      if (val.max_items !== undefined && v.length > val.max_items) return 'max_items';
      return v.every((x) => (val.options ?? []).some((o) => o.value === x)) ? null : 'option';
    case 'datetime': {
      if (typeof v !== 'string') return 'type';
      const t = instant(v);
      if (t === null) return 'type';
      if (val.not_before !== undefined && t < Date.parse(val.not_before)) return 'not_before';
      if (val.not_after !== undefined && t > Date.parse(val.not_after)) return 'not_after';
      return null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? null : 'type';
    case 'staff_member':
      return typeof v === 'string' && UUID.test(v) ? null : 'type';
    case 'attachment': {
      const items = v as Array<{ mime?: unknown; size_bytes?: unknown }>;
      if (!Array.isArray(items) || items.some((x) => typeof x?.mime !== 'string' || !Number.isInteger(x?.size_bytes))) {
        return 'type';
      }
      if (val.min_items !== undefined && items.length < val.min_items) return 'min_items';
      if (val.max_items !== undefined && items.length > val.max_items) return 'max_items';
      if (items.some((x) => !mimeAccepted(x.mime as string, val.accept ?? []))) return 'accept';
      if (val.max_size_bytes !== undefined && items.some((x) => (x.size_bytes as number) > val.max_size_bytes!)) {
        return 'max_size_bytes';
      }
      return null;
    }
    default:
      // location وأي نوع غير مدعوم: لا يصل إلى هنا في v0 (بوابة POST /forms)
      return 'type';
  }
}

/**
 * الحقول المرئية: يطابق `material_types` أحد أنواع المادة (أو لا يحددها) ويتحقق `condition` من حقل مرئي.
 * المادة قد تحمل أكثر من نوع؛ الحقل مرئي إن انطبق على أي منها (نوع واحد = سلوك الاختبار المشترك نفسه).
 */
export function visibleFieldKeys(form: UploadForm, materialTypes: string[], values: Record<string, unknown>): Set<string> {
  const visible = new Set<string>();
  for (const f of form.fields) {
    if (f.material_types?.length && !f.material_types.some((t) => materialTypes.includes(t))) continue;
    if (f.condition) {
      if (!visible.has(f.condition.field)) continue;
      const cv = values[f.condition.field];
      const met = Array.isArray(cv) ? cv.includes(f.condition.equals) : cv === f.condition.equals;
      if (!met) continue;
    }
    visible.add(f.key);
  }
  return visible;
}

/** خطأ واحد لكل حقل مرئي بترتيب النموذج. */
export function validateDynamicFields(
  form: UploadForm,
  materialTypes: string[],
  values: Record<string, unknown>,
): { valid: boolean; errors: FieldError[]; visible: Set<string> } {
  const visible = visibleFieldKeys(form, materialTypes, values);
  const errors: FieldError[] = [];
  for (const f of form.fields) {
    if (!visible.has(f.key)) continue;
    const code = checkField(f, values[f.key]);
    if (code) errors.push({ field: f.key, code });
  }
  return { valid: errors.length === 0, errors, visible };
}

/** ما يُحفظ: قيم الحقول المرئية غير الفارغة فقط؛ المخفي يُتجاهل بقيمته (الدلالات) ولا يُخزَّن. */
export function storedDynamicFields(values: Record<string, unknown>, visible: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => visible.has(k) && !isEmpty(v)));
}
