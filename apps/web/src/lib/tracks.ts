import type { Material } from "./types";

// خط المسارات الثلاثة (Figma: Track Line، docs/design/design-system.md §1.2): الحالات الثلاث مستقلة دائمًا وتُعرض بالترتيب
// فنية ← تحريرية ← حقوق؛ الحالة مرمّزة بالشكل قبل اللون (إطار، نصف تعبئة، تعبئة، كهرماني، أحمر مخطَّط). لا يقرر حالة ولا صلاحية.
export type TrackKey = "technical_state" | "editorial_state" | "rights_state";
export type SegmentState = "empty" | "progress" | "done" | "attention" | "blocked";
export const trackOrder = ["technical_state", "editorial_state", "rights_state"] as const satisfies readonly TrackKey[];

// التقدّم أحادي الاتجاه: لم يبدأ ← جارٍ ← مكتمل. «مكتمل» تحريريًا = اعتُمدت المادة (accepted فما بعدها)، فلا تتراجع القطعة أثناء الإنتاج.
const segments: { [K in TrackKey]: Record<Material[K], SegmentState> } = {
  technical_state: { pending: "empty", proxy_received: "progress", original_received: "progress", verified: "done", failed: "blocked" },
  editorial_state: { inbox: "empty", acknowledged: "progress", reviewing: "progress", needs_changes: "attention", accepted: "done", in_production: "done", final_review: "done", published: "done", rejected: "blocked" },
  rights_state: { unknown: "empty", documented: "progress", sellable: "done", blocked: "blocked", withdrawn: "blocked" },
};

export const segmentState = <K extends TrackKey>(track: K, value: Material[K]): SegmentState => (segments[track] as Record<string, SegmentState>)[value] ?? "empty";

/** المسارات التي تستحق سطر شرح تحت الخط (انتباه أو توقف)، بترتيب المسارات. */
export const flaggedTracks = (material: Pick<Material, TrackKey>) =>
  trackOrder.map(track => ({ track, value: material[track], state: segmentState(track, material[track]) })).filter(item => item.state === "attention" || item.state === "blocked");
