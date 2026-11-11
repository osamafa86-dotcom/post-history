import type { Material, MaterialFile } from "./types";
import { isSensitive } from "./render-policy";

/**
 * «موادي» على الويب بسلوك iOS (ADR 0089): معرض بطاقات الأحدث أولًا، مجمّع بعنوان التغطية أو بالنوع، برقاقات «الكل · فيديو · صور · عاجل».
 * كل ما هنا منطق صرف يُختبر وحده؛ لا طلب ولا تخزين.
 */
export type MineFilter = "all" | "video" | "photos" | "urgent";
export type MineGrouping = "coverage" | "type";
export const mineFilters: MineFilter[] = ["all", "video", "photos", "urgent"];

/** ما يحتاج المراسل أن يفعل فيه شيئًا: طلب تعديل من المشرف، أو رفع فشل ويُعاد. */
export const needsAction = (material: Material) => material.editorial_state === "needs_changes" || material.technical_state === "failed";

export function matchesFilter(material: Material, filter: MineFilter) {
  if (filter === "all") return true;
  if (filter === "urgent") return material.priority === "urgent";
  const photos = material.material_types.includes("photos");
  return filter === "photos" ? photos : !photos;
}

/** عنوان التغطية: العنوان بلا لاحقة الإرسالة « (i/N)» (ADR 0081)، فمواد الإرسالة الواحدة مجموعة واحدة. */
export const coverageTitle = (title: string) => title.replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/u, "").trim() || title.trim();

/** مفتاح المطابقة العربية المطويّة: بلا تشكيل ولا تطويل، والألفات والتاء المربوطة والألف المقصورة موحّدة، والمسافات مطويّة. */
export function arabicFold(text: string) {
  return text.normalize("NFKC").replace(/[ً-ٰٟـ]/gu, "").replace(/[آأإٱ]/gu, "ا")
    .replace(/ة/gu, "ه").replace(/ى/gu, "ي").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

/** اليوم بأيام التقويم المحلي: «اليوم» و«أمس» وإلا التاريخ. */
export function dayKind(value: string, now: Date): "today" | "yesterday" | "date" {
  const day = new Date(value);
  if (!Number.isFinite(day.getTime())) return "date";
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  // اليوم السابق بالتقويم لا بطرح 24 ساعة، فيصحّ يوم تغيير التوقيت الصيفي.
  return at === new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() ? "today" : at === new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime() ? "yesterday" : "date";
}

export type MineGroup = { key: string; title: string; type: Material["material_types"][number] | null; newest: string; items: Material[] };
/**
 * التجميع (07): بعنوان التغطية (الافتراضي) أو بالنوع الأول للمادة. المجموعات بترتيب أحدث موادها، والمواد داخلها الأحدث أولًا.
 */
export function groupMaterials(items: Material[], by: MineGrouping): MineGroup[] {
  const groups = new Map<string, MineGroup>();
  const sorted = [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const item of sorted) {
    const type = item.material_types[0] ?? null, title = coverageTitle(item.title);
    const key = by === "coverage" ? `c:${arabicFold(title)}` : `t:${type ?? ""}`;
    const group = groups.get(key) ?? { key, title, type, newest: item.created_at, items: [] };
    group.items.push(item); groups.set(key, group);
  }
  return [...groups.values()];
}

export type MineSection = { key: string; kind: "today" | "week" | "month"; month: string | null; groups: MineGroup[] };
/**
 * أقسام الشبكة المتصلة بالزمن بدل قسم لكل تغطية: اليوم، ثم هذا الأسبوع (الأيام الستة السابقة بالتقويم المحلي)، ثم شهر بعد شهر.
 * المجموعة تقع في قسم أحدث موادها، وترتيب المجموعات كما وصل (الأحدث أولًا).
 */
export function timeSections(groups: MineGroup[], now: Date): MineSection[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  const sections = new Map<string, MineSection>();
  for (const group of groups) {
    const at = new Date(group.newest), known = Number.isFinite(at.getTime()), day = known ? new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() : 0;
    const kind = day >= today ? "today" : day >= week ? "week" : "month", month = kind === "month" && known ? `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}` : null;
    const key = kind === "month" ? `m:${month ?? ""}` : kind, section = sections.get(key) ?? { key, kind, month, groups: [] };
    section.groups.push(group); sections.set(key, section);
  }
  return [...sections.values()];
}
/** اسم الشهر والسنة لعنوان القسم («تشرين الأول 2026») بأرقام لاتينية. */
export function monthName(month: string, locale: "ar" | "en") {
  const [year, value] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-PS-u-nu-latn" : "en", { month: "long", year: "numeric" }).format(new Date(year, value - 1, 1));
}

/** مدة الفيديو من أطول ملف يحمل مدة؛ بلا ملف فلا مدة. */
export function materialDuration(material: Material) {
  const values = material.files.map(file => file.duration_ms ?? 0).filter(ms => Number.isSafeInteger(ms) && ms > 0);
  return values.length ? Math.max(...values) : null;
}
export function durationLabel(ms: number) {
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), mm = Math.floor(total / 60) % 60, ss = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

/**
 * مصغّرة البطاقة: `thumbnail` متحقَّق منه وحده، ولا تُطلب للمادة الحسّاسة أو المجهولة الحساسية (فشل مغلق، ADR 0089 §1)، فتظهر لها
 * علامة «حسّاسة · لا معاينة سحابية». وإلا أيقونة النوع.
 */
export function cardMedia(material: Material): { kind: "sensitive" } | { kind: "thumbnail"; file: MaterialFile } | { kind: "icon"; photos: boolean } {
  if (isSensitive(material)) return { kind: "sensitive" };
  const file = material.files.find(item => item.kind === "thumbnail" && item.state === "verified");
  return file ? { kind: "thumbnail", file } : { kind: "icon", photos: material.material_types.includes("photos") };
}

/** الأعداد فوق المعرض: كل المواد، وما يحتاج إجراءً، وما ينتظر المراجعة، والمعتمد. */
export function mineCounts(items: Material[]) {
  const reviewing = ["inbox", "acknowledged", "reviewing"], approved = ["accepted", "in_production", "final_review", "published"];
  return { all: items.length, action: items.filter(needsAction).length, reviewing: items.filter(item => reviewing.includes(item.editorial_state)).length,
    approved: items.filter(item => approved.includes(item.editorial_state)).length };
}
