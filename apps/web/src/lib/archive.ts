import type { Material, RoleName } from "./types";
import { matchesSearch } from "./inbox-tabs";

/**
 * الأرشيف الجاهز (W9): المواد المنشورة (`editorial_state=published`) الأحدث تعديلًا أولًا، لطاقم غرفة الأخبار الذي يقرأ المواد في نطاقه.
 * العقد بلا معامل بحث ولا سجلّ نشر على المنصات، فالبحث والرقاقات تصفّي الصفحات المحمّلة كالوارد، ورقاقات المنصّات ومشاهداتها فجوة (ADR 0103).
 */
export const archiveRoles = ["supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin"] as const satisfies readonly RoleName[];
export type ArchivePeriod = "" | "week" | "month";
export type ArchiveFilters = { q: string; period: ArchivePeriod; governorate: string };
export const noFilters: ArchiveFilters = { q: "", period: "", governorate: "" };
const periodDays = { week: 7, month: 30 } as const;

/** الفترة بتاريخ آخر تعديل (أقرب ما في العقد إلى وقت النشر)، بالأيام لا بالأسبوع التقويمي (بدايته تختلف، ADR 0096). */
export function inPeriod(material: Material, period: ArchivePeriod, now: number) {
  if (!period) return true;
  const at = Date.parse(material.updated_at);
  return Number.isFinite(at) && now - at <= periodDays[period] * 86400000;
}
export const archiveFields = (item: Material) => [item.title, item.governorate, item.city, ...(item.tags ?? [])];
export function filterArchive(items: Material[], filters: ArchiveFilters, now: number) {
  return items.filter(item => inPeriod(item, filters.period, now) && (!filters.governorate || item.governorate === filters.governorate) && matchesSearch(filters.q, archiveFields(item)));
}
/** شرائح المحافظة من المواد المحمّلة نفسها (لا قائمة مكتوبة)، الأكثر موادَّ أولًا، حتى ست؛ والمختارة تبقى ظاهرة. */
export function archiveGovernorates(items: Material[], active?: string) {
  const counts = new Map<string, number>();
  for (const item of items) if (item.governorate) counts.set(item.governorate, (counts.get(item.governorate) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name).slice(0, 6);
  return active && !ranked.includes(active) ? [...ranked, active] : ranked;
}
export const activeFilters = (filters: ArchiveFilters) => (Object.entries(filters) as [keyof ArchiveFilters, string][]).filter(([, value]) => value);
