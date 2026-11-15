import { materialTypes } from "./query";

// مرشحات الكتالوج (S1) وقيمها المقبولة، خارج مكوّن العميل لتقرأها صفحة الخادم من رابطها: الرجوع من مادة وإعادة التحميل ورابط يُرسل لزميل تعيد
// البحث نفسه. المفاتيح المعروفة بقيمها المقبولة وحدها؛ ما عداها يُهمل.
export const licenseTypes = ["editorial_single", "editorial_term", "exclusive_temporary", "commercial"] as const;
export const durationKeys = ["short", "medium", "long"] as const;
export const heights = ["720", "1080", "2160"] as const;
export const periods = ["recent", "week", "month"] as const;
export type Filters = Partial<Record<"q" | "material_type" | "governorate" | "shot_from" | "shot_to" | "period" | "duration" | "min_height" | "license_type" | "exclusive_available", string>>;

const day = /^\d{4}-\d{2}-\d{2}$/, among = (list: readonly string[]) => (value: string) => list.includes(value);
const accepted: Record<keyof Filters, (value: string) => boolean> = {
  q: value => value.length <= 200, material_type: among(materialTypes), governorate: value => value.length <= 80, shot_from: value => day.test(value), shot_to: value => day.test(value),
  period: among(periods), duration: among(durationKeys), min_height: among(heights), license_type: among(licenseTypes), exclusive_available: value => value === "true",
};
const filterKeys = Object.keys(accepted) as (keyof Filters)[];
/** المرشحات من رابط الصفحة: البحث مشذَّبًا، وما لا يُعرف مفتاحه أو لا تُقبل قيمته يُهمل. */
export function filtersFromSearch(search: URLSearchParams | Record<string, string | string[] | undefined>): Filters {
  const filters: Filters = {};
  for (const key of filterKeys) {
    const raw = search instanceof URLSearchParams ? search.get(key) : search[key], value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && accepted[key](value)) filters[key] = value;
  }
  return filters;
}
/** المرشحات لرابط الصفحة، بترتيب ثابت وبلا قيم فارغة: المرشحات نفسها تعطي الرابط نفسه. */
export function filtersSearch(filters: Filters) {
  const params = new URLSearchParams();
  for (const key of filterKeys) if (filters[key]) params.set(key, filters[key]!);
  return params.toString();
}
