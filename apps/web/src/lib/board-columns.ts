import type { Material, NewsroomDashboard } from "./types";
import { boardOrder } from "./board";

// أعمدة لوحة الإنتاج الأربعة (Figma 193:862، قرار المالك 2026-10-27، ADR 0078): واردة / قيد التحقق / جاهزة للنشر / متوقفة.
// تجميع للحالات التحريرية والفنية في العقد دون تغييره؛ لا حالة جديدة ولا حقل جديد. الجدول المعتمد في ADR 0078.
export const productionColumns = ["incoming", "checking", "ready", "stalled"] as const;
export type ProductionColumn = typeof productionColumns[number];
type Editorial = Material["editorial_state"];
type Technical = Material["technical_state"];

export const editorialStates = ["inbox", "acknowledged", "reviewing", "needs_changes", "accepted", "in_production", "final_review", "published", "rejected"] as const satisfies readonly Editorial[];
/** الحالات الفنية التي لم تكتمل بعد (لا فشل): الاستلام ما زال جاريًا. */
export const technicalProcessing = ["pending", "proxy_received", "original_received"] as const satisfies readonly Technical[];
/** الحالات الفنية التي تُجلب كاملةً لأن موضع المادة فيها لا يتبع حالتها التحريرية وحدها. */
export const technicalOffTrack = [...technicalProcessing, "failed"] as const satisfies readonly Technical[];

const isEditorial = (value: string): value is Editorial => (editorialStates as readonly string[]).includes(value);

/**
 * عمود المادة، بأولوية صريحة عند تداخل المسارين:
 * 1. `published` خارج اللوحة (انتهى الإنتاج).
 * 2. متوقفة: `needs_changes` أو `rejected` أو فشل فني، ولو كانت `accepted` (الفشل يغلب القبول).
 * 3. قيد التحقق: `acknowledged` أو `reviewing`، أو الاستلام الفني لم يكتمل (يغلب القبول و`inbox`: لا تُعدّ جاهزة ولا واردة قبل التحقق).
 * 4. جاهزة للنشر: `accepted` و`in_production` و`final_review` بعد اكتمال التحقق الفني.
 * 5. واردة: `inbox` بعد اكتمال التحقق الفني.
 */
export function productionColumn(editorial: Editorial, technical: Technical): ProductionColumn | null {
  if (editorial === "published") return null;
  if (editorial === "rejected" || editorial === "needs_changes" || technical === "failed") return "stalled";
  if (editorial === "acknowledged" || editorial === "reviewing" || technical !== "verified") return "checking";
  return editorial === "inbox" ? "incoming" : "ready";
}

/** الحالات التحريرية التي تُجلب بطاقاتها مع `technical_state=verified`، مجمّعة بعمودها (من دونها يُجلب الباقي عبر الحالات الفنية). */
export const verifiedQueries = editorialStates.flatMap(state => { const column = productionColumn(state, "verified"); return column ? [{ state, column }] : []; });

/**
 * عدّاد كل عمود. اللقطة تعطي عدّاد كل مسار وحده، لا التقاطع بينهما، فيُحسب الدقيق هكذا:
 * المواد غير المكتملة فنيًا (جارية أو فاشلة) تُجلب كلها (`open`) ويُصنَّف كل منها بحالتيه، والباقي مكتمل فنيًا
 * فعمودُه من حالته التحريرية وعدّه = عدّاد الحالة في اللقطة مطروحًا منه ما صُنّف من `open`.
 */
export function columnCounts(editorial: NewsroomDashboard["editorial"], open: readonly Pick<Material, "editorial_state" | "technical_state">[]): Record<ProductionColumn, number> {
  const total: Record<ProductionColumn, number> = { incoming: 0, checking: 0, ready: 0, stalled: 0 }, offTrack = new Map<Editorial, number>();
  for (const item of open) {
    const column = productionColumn(item.editorial_state, item.technical_state);
    if (column) { total[column]++; offTrack.set(item.editorial_state, (offTrack.get(item.editorial_state) ?? 0) + 1); }
  }
  for (const { state, count } of editorial) {
    if (!isEditorial(state)) continue;
    const column = productionColumn(state, "verified");
    if (column) total[column] += Math.max(0, count - (offTrack.get(state) ?? 0));
  }
  return total;
}

/** بطاقات الأعمدة من المجموعتين المجلوبتين (بلا تكرار)، مرتبة: عاجل ثم مهم ثم الأقدم، ومقصوصة إلى `limit`. */
export function columnCards(verified: readonly Material[], open: readonly Material[], limit: number): Record<ProductionColumn, Material[]> {
  const seen = new Set<string>(), grouped: Record<ProductionColumn, Material[]> = { incoming: [], checking: [], ready: [], stalled: [] };
  for (const item of [...open, ...verified]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const column = productionColumn(item.editorial_state, item.technical_state);
    if (column) grouped[column].push(item);
  }
  for (const column of productionColumns) grouped[column] = boardOrder(grouped[column]).slice(0, limit);
  return grouped;
}
