import type { MaterialQuery, NewsroomDashboard } from "./types";

// التصفية السريعة في الوارد الحي (Figma 193:620): حالات تحريرية وفنية من عقد `/materials`، وعدّاداتها من لقطة غرفة الأخبار حين تتوفر.
export const inboxTabs = ["all", "urgent", "inbox", "reviewing", "accepted", "stopped"] as const;
export type InboxTab = (typeof inboxTabs)[number];

export const tabQuery: Record<InboxTab, MaterialQuery> = {
  all: {}, urgent: { priority: "urgent" }, inbox: { editorial_state: "inbox" }, reviewing: { editorial_state: "reviewing" }, accepted: { editorial_state: "accepted" }, stopped: { technical_state: "failed" },
};

/** التبويب الذي يطابق الاستعلام الحالي تمامًا، أو `null` حين تكون التصفية مخصّصة (من لوحة التصفية المتقدمة). */
export function activeTab(query: MaterialQuery): InboxTab | null {
  const keys = Object.entries(query).filter(([key, value]) => key !== "limit" && key !== "cursor" && value !== undefined);
  return inboxTabs.find(tab => { const wanted = Object.entries(tabQuery[tab]); return wanted.length === keys.length && wanted.every(([key, value]) => (query as Record<string, unknown>)[key] === value); }) ?? null;
}

/** العدّادات من اللقطة: «عاجلة» = العاجل المفتوح (لم يُنشر ولم يُرفض)، و«متوقفة» = فشل الاستلام الفني. لا شيء يُحسب خارج ما يعيده الخادم. */
export function tabCounts(snapshot: NewsroomDashboard): Record<InboxTab, number> {
  const editorial = (state: string) => snapshot.editorial.find(item => item.state === state)?.count ?? 0;
  return { all: snapshot.editorial.reduce((sum, item) => sum + item.count, 0), urgent: snapshot.urgent_open, inbox: editorial("inbox"), reviewing: editorial("reviewing"), accepted: editorial("accepted"), stopped: snapshot.technical.find(item => item.state === "failed")?.count ?? 0 };
}

/** التبويب «عاجلة» يعرض العاجل المفتوح فقط كي يطابق عدّاده؛ الاستعلام لا يستبعد المنشور والمرفوض. */
export const isOpenUrgent = (material: { priority: string; editorial_state: string }) => material.priority === "urgent" && material.editorial_state !== "published" && material.editorial_state !== "rejected";

/** بحث نصي داخل الصفحة المحمّلة: عقد `/materials` بلا معامل بحث، فالبحث هنا على العنوان والمحافظة والإيصال المعروضة وحدها. */
export function matchesSearch(needle: string, fields: (string | null | undefined)[]) {
  const q = needle.trim().toLocaleLowerCase();
  return !q || fields.some(field => field?.toLocaleLowerCase().includes(q));
}
