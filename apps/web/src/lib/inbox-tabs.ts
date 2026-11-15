import type { MaterialQuery, Me, NewsroomDashboard } from "./types";
import { hasRole } from "./review";

// التصفية السريعة في الوارد الحي (Figma 193:620): حالات تحريرية وفنية من عقد `/materials`، وعدّاداتها من لقطة غرفة الأخبار حين تتوفر.
export const inboxTabs = ["all", "urgent", "inbox", "reviewing", "accepted", "final_review", "stopped"] as const;
export type InboxTab = (typeof inboxTabs)[number];
/** «قيد المراجعة» عمل المشرف كله بعد الاستلام: ما اطّلع عليه، وما يراجعه، وما طلب تعديله. فلا تخرج المادة من التبويبات حين تُستلم. */
export const reviewingStates = ["acknowledged", "reviewing", "needs_changes"] as const;

export const tabQuery: Record<InboxTab, MaterialQuery> = {
  all: {}, urgent: { priority: "urgent" }, inbox: { editorial_state: "inbox" },
  // قائمة الحالات يفهمها الـBFF وحده (`server/material-list.ts`)؛ العقد حالة واحدة في الطلب.
  reviewing: { editorial_state: reviewingStates.join(",") as MaterialQuery["editorial_state"] },
  accepted: { editorial_state: "accepted" }, final_review: { editorial_state: "final_review" }, stopped: { technical_state: "failed" },
};

/** تبويبات المستخدم: «مراجعة نهائية» لمن يملك النشر وحده (رئيس التحرير)، فهي ما ينتظره هو. */
export const tabsFor = (me: Me): InboxTab[] => inboxTabs.filter(tab => tab !== "final_review" || hasRole(me, "editor_in_chief"));

/** التبويب الذي يطابق الاستعلام الحالي تمامًا، أو `null` حين تكون التصفية مخصّصة (من لوحة التصفية المتقدمة). */
export function activeTab(query: MaterialQuery): InboxTab | null {
  const keys = Object.entries(query).filter(([key, value]) => key !== "limit" && key !== "cursor" && value !== undefined);
  return inboxTabs.find(tab => { const wanted = Object.entries(tabQuery[tab]); return wanted.length === keys.length && wanted.every(([key, value]) => (query as Record<string, unknown>)[key] === value); }) ?? null;
}

/** العدّادات من اللقطة: «عاجلة» = العاجل المفتوح (لم يُنشر ولم يُرفض)، و«متوقفة» = فشل الاستلام الفني. لا شيء يُحسب خارج ما يعيده الخادم. */
export function tabCounts(snapshot: NewsroomDashboard): Record<InboxTab, number> {
  const editorial = (...list: string[]) => snapshot.editorial.reduce((sum, item) => list.includes(item.state) ? sum + item.count : sum, 0);
  return { all: snapshot.editorial.reduce((sum, item) => sum + item.count, 0), urgent: snapshot.urgent_open, inbox: editorial("inbox"), reviewing: editorial(...reviewingStates), accepted: editorial("accepted"), final_review: editorial("final_review"), stopped: snapshot.technical.find(item => item.state === "failed")?.count ?? 0 };
}

/** التبويب «عاجلة» يعرض العاجل المفتوح فقط كي يطابق عدّاده؛ الاستعلام لا يستبعد المنشور والمرفوض. */
export const isOpenUrgent = (material: { priority: string; editorial_state: string }) => material.priority === "urgent" && material.editorial_state !== "published" && material.editorial_state !== "rejected";

/** الأرقام العربية الهندية والفارسية تُقرأ كاللاتينية في الطرفين: «13» تجد «١٣» والعكس. */
const plain = (value: string) => value.toLocaleLowerCase().replace(/[\u0660-\u0669\u06f0-\u06f9]/g, digit => String(digit.charCodeAt(0) & 0xf));

/** بحث نصي داخل الصفحة المحمّلة: عقد `/materials` بلا معامل بحث، فالبحث هنا على العنوان والمحافظة والإيصال المعروضة وحدها. */
export function matchesSearch(needle: string, fields: (string | null | undefined)[]) {
  const q = plain(needle.trim());
  return !q || fields.some(field => field != null && plain(field).includes(q));
}

/**
 * مصغّرة صف الوارد (W1، ADR 0104، 0105): `thumbnail_file_id` وحده، والخادم لا يضعه إلا لمصغّرة متحقَّقة. المادة الحسّاسة أو المجهولة الحساسية
 * لا تُطلب مصغّرتها (فشل مغلق، ADR 0089 §1) فتظهر علامتها، وما سواها أيقونة النوع.
 */
export function rowThumb(material: { thumbnail_file_id?: string | null; material_types: readonly string[] }, sensitive: boolean): { kind: "sensitive" } | { kind: "thumbnail"; id: string } | { kind: "icon"; photos: boolean } {
  if (sensitive) return { kind: "sensitive" };
  return material.thumbnail_file_id ? { kind: "thumbnail", id: material.thumbnail_file_id } : { kind: "icon", photos: material.material_types.includes("photos") };
}

/** رقاقات النوع: تصفّي الصفحة المحمّلة وحدها (عقد `/materials` بلا معامل نوع)، و«كل الأنواع» بلا قيمة. */
export const matchesType = (material: { material_types: readonly string[] }, type: string) => !type || material.material_types.includes(type);
