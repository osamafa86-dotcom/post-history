import { browserApi, dataOrThrow } from "./browser-api";
import { columnCards, columnCounts, technicalOffTrack, unfetchedItems, verifiedQueries, type ColumnCount, type ProductionColumn } from "./board-columns";
import type { Material, NewsroomDashboard } from "./types";

export const pageSize = 100, maxPages = 5;
/** أكبر عدد يُجلب من مواد حالة فنية واحدة غير مكتملة؛ ما بعده لا يُخمَّن، بل يُعلَن العدّاد حدًّا أدنى (ADR 0078). */
export const fetchCap = pageSize * maxPages;

type Technical = Material["technical_state"];
export type BoardData = { verified: Material[]; open: Material[]; /** الحالات الفنية التي بلغ جلبها السقف وبقي منها ما لم يُجلب. */ truncated: Technical[] };
type Page = { items: Material[]; next_cursor?: string | null };

/** يجلب الصفحات بالمؤشر حتى تنتهي أو يبلغ `pages`؛ `truncated` صحيح إن بقيت صفحة تالية بعد آخر صفحة مجلوبة. */
export async function fetchPages(fetchPage: (cursor?: string) => Promise<Page>, pages = maxPages): Promise<{ items: Material[]; truncated: boolean }> {
  const items: Material[] = []; let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (!result.next_cursor) return { items, truncated: false };
    cursor = result.next_cursor;
  }
  return { items, truncated: true };
}

/**
 * يجلب ما تحتاجه الأعمدة الأربعة: بطاقات كل حالة تحريرية مكتملة الاستلام (حتى `limit`)، ثم المواد غير المكتملة فنيًا كلها
 * (جارية أو فاشلة، بصفحات من مئة حتى `fetchCap` لكل حالة) لأن عمودها يتبع المسارين معًا ولا تعطيه اللقطة وحدها.
 * وإن بلغت حالة السقف سُجّلت في `truncated` فلا يُدّعى عدّاد دقيق.
 */
export async function loadBoard(signal: AbortSignal, limit: number): Promise<BoardData> {
  const api = browserApi();
  const verified = await Promise.all(verifiedQueries.map(({ state }) => api.GET("/materials", { params: { query: { editorial_state: state, technical_state: "verified", limit } }, signal }).then(dataOrThrow).then(page => page.items)));
  const open = await Promise.all(technicalOffTrack.map(async technical => ({ technical, ...await fetchPages(async cursor => dataOrThrow(await api.GET("/materials", { params: { query: { technical_state: technical, limit: pageSize, ...(cursor ? { cursor } : {}) } }, signal }))) })));
  return { verified: verified.flat(), open: open.flatMap(entry => entry.items), truncated: open.filter(entry => entry.truncated).map(entry => entry.technical) };
}

/** أعمدة اللوحة من لقطة غرفة الأخبار وما جُلب: العدّاد (دقيق أو حدّ أدنى وأعلى إن بلغ الجلب سقفه) والبطاقات المرتبة. */
export function arrange(snapshot: NewsroomDashboard, data: BoardData, limit: number): { counts: Record<ProductionColumn, ColumnCount>; cards: Record<ProductionColumn, Material[]>; capped: boolean } {
  return { counts: columnCounts(snapshot.editorial, data.open, unfetchedItems(snapshot.technical, data.open, data.truncated)), cards: columnCards(data.verified, data.open, limit), capped: data.truncated.length > 0 };
}
