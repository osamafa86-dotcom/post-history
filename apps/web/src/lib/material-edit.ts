import type { Material, MaterialType, TransitionRecord } from "./types";
import { materialTypes } from "./query";
import { titleLimits } from "./upload-policy";

// تعديل صاحب المادة لحقولها الوصفية من الويب (قرار المنسّق 2026-11-15)؛ قواعد يشترك فيها المتصفح والـBFF.
/** الحالات التحريرية التي يعدّل فيها صاحب المادة حقولها: كل ما قبل القبول، عدا المرفوضة. */
export const editableStates = ["inbox", "acknowledged", "reviewing", "needs_changes"] as const satisfies readonly Material["editorial_state"][];
export const editableFields = ["title", "governorate", "city", "material_types"] as const;
export type MaterialEdit = { title?: string; governorate?: string; city?: string; material_types?: MaterialType[] };
export type EditField = typeof editableFields[number];
/** أقل طول لجواب المراسل حين يعيد الإرسال، كما يطلب الخادم سببَ الانتقال. */
export const answerMin = 5;

const within = (value: unknown, min: number, max: number): value is string => typeof value === "string" && Array.from(value.trim()).length >= min && Array.from(value).length <= max;
/** الحقول الخاطئة في تعديل مقترح، بترتيب النموذج. */
export function editErrors(edit: { title: string; governorate: string; city: string; material_types: readonly string[] }): EditField[] {
  const errors: EditField[] = [];
  if (!within(edit.title, titleLimits.min, titleLimits.max)) errors.push("title");
  if (!within(edit.governorate, 1, 64)) errors.push("governorate");
  if (!within(edit.city, 1, 64)) errors.push("city");
  if (!edit.material_types.length || new Set(edit.material_types).size !== edit.material_types.length || edit.material_types.some(type => !(materialTypes as readonly string[]).includes(type))) errors.push("material_types");
  return errors;
}
/** جسم التعديل كما يقبله الـBFF: حقل واحد على الأقل من الأربعة، ولا مفتاح غيرها، وكلٌّ بحدوده. */
export function editInput(body: Record<string, unknown>): MaterialEdit | null {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !(editableFields as readonly string[]).includes(key))) return null;
  const edit: MaterialEdit = {};
  if ("title" in body) { if (!within(body.title, titleLimits.min, titleLimits.max)) return null; edit.title = body.title.trim(); }
  if ("governorate" in body) { if (!within(body.governorate, 1, 64)) return null; edit.governorate = body.governorate.trim(); }
  if ("city" in body) { if (!within(body.city, 1, 64)) return null; edit.city = body.city.trim(); }
  if ("material_types" in body) {
    const types = body.material_types;
    if (!Array.isArray(types) || !types.length || new Set(types).size !== types.length || types.some(type => !(materialTypes as readonly unknown[]).includes(type))) return null;
    edit.material_types = materialTypes.filter(type => types.includes(type));
  }
  return edit;
}
/** ما تغيّر وحده، فلا يُرسل حقل لم يمسّه صاحبه. `null` حين لم يتغيّر شيء. */
export function changedFields(material: Pick<Material, "title" | "governorate" | "city" | "material_types">, edit: { title: string; governorate: string; city: string; material_types: readonly string[] }): MaterialEdit | null {
  const out: MaterialEdit = {};
  if (edit.title.trim() !== material.title) out.title = edit.title.trim();
  if (edit.governorate.trim() !== material.governorate) out.governorate = edit.governorate.trim();
  if (edit.city.trim() !== material.city) out.city = edit.city.trim();
  const types = materialTypes.filter(type => edit.material_types.includes(type));
  if (types.join() !== materialTypes.filter(type => (material.material_types as readonly string[]).includes(type)).join()) out.material_types = types;
  return Object.keys(out).length ? out : null;
}
/** آخر طلب تعديل في السجل (ملاحظة المشرف وتوقيتها)، أيًّا كان ترتيب السجل. */
export function changeRequest(records: readonly TransitionRecord[] | null): TransitionRecord | null {
  const requests = (records ?? []).filter(record => record.track === "editorial" && record.to === "needs_changes");
  return requests.reduce<TransitionRecord | null>((latest, record) => !latest || Date.parse(record.occurred_at) >= Date.parse(latest.occurred_at) ? record : latest, null);
}
