import type { Material } from "./types";

// مساعدات عرض للوحة غرفة الأخبار على الشاشة الكبيرة (#385، docs/design/specs/supervisor-board.md)؛ لا تقرر حالة.
export const displayPage = 8, rotateMs = 20000;
const rank: Record<Material["priority"], number> = { urgent: 0, important: 1, normal: 2 };

/** ترتيب العمود: عاجل ثم مهم ثم الأقدم. */
export const boardOrder = (items: Material[]) => [...items].sort((a, b) => rank[a.priority] - rank[b.priority] || Date.parse(a.created_at) - Date.parse(b.created_at));

/** نافذة التدوير: ثماني بطاقات، وتنتقل الصفحة كل عشرين ثانية حين يزيد العمود عنها. */
export function rotation(items: Material[], tick: number) {
  const pages = Math.max(1, Math.ceil(items.length / displayPage)), page = tick % pages;
  return { shown: items.slice(page * displayPage, page * displayPage + displayPage), page, pages };
}

/** HH:MM:SS بتوقيت الجهاز للساعة وآخر لقطة؛ أرقام لاتينية في الواجهتين. */
export const wallClock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

/** هل زاد عدّاد منذ اللقطة السابقة؟ الصوت مرة عند دخول عاجل جديد أو تجاوز مهلة جديد. */
export const rose = (previous: { urgent_open: number; overdue_acknowledgements: number } | null, next: { urgent_open: number; overdue_acknowledgements: number }) =>
  !!previous && (next.urgent_open > previous.urgent_open || next.overdue_acknowledgements > previous.overdue_acknowledgements);

/** من الموعد الذي أعاده الخادم وحده، لا من قواعد التنبيه أو وقت إنشاء المادة. */
export function overdueTime(from: string | null | undefined, now: number): string | null {
  const at = from ? Date.parse(from) : NaN;
  if (!Number.isFinite(at) || at >= now) return null;
  const seconds = Math.floor((now - at) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
