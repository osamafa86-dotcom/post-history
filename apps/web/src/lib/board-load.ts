import { browserApi, dataOrThrow } from "./browser-api";
import { columnCards, columnCounts, technicalOffTrack, verifiedQueries, type ProductionColumn } from "./board-columns";
import type { Material, NewsroomDashboard } from "./types";

const pageSize = 100, maxPages = 5;

export type BoardData = { verified: Material[]; open: Material[] };

/**
 * يجلب ما تحتاجه الأعمدة الأربعة: بطاقات كل حالة تحريرية مكتملة الاستلام (حتى `limit`)، ثم المواد غير المكتملة فنيًا كلها
 * (جارية أو فاشلة، بصفحات من مئة حتى خمس صفحات) لأن عمودها يتبع المسارين معًا ولا تعطيه اللقطة وحدها.
 */
export async function loadBoard(signal: AbortSignal, limit: number): Promise<BoardData> {
  const api = browserApi();
  const verified = await Promise.all(verifiedQueries.map(({ state }) => api.GET("/materials", { params: { query: { editorial_state: state, technical_state: "verified", limit } }, signal }).then(dataOrThrow).then(page => page.items)));
  const open = await Promise.all(technicalOffTrack.map(async technical => {
    const items: Material[] = []; let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = dataOrThrow(await api.GET("/materials", { params: { query: { technical_state: technical, limit: pageSize, ...(cursor ? { cursor } : {}) } }, signal }));
      items.push(...result.items); if (!result.next_cursor) break; cursor = result.next_cursor;
    }
    return items;
  }));
  return { verified: verified.flat(), open: open.flat() };
}

/** أعمدة اللوحة من لقطة غرفة الأخبار وما جُلب: العدّاد الدقيق والبطاقات المرتبة. */
export function arrange(snapshot: NewsroomDashboard, data: BoardData, limit: number): { counts: Record<ProductionColumn, number>; cards: Record<ProductionColumn, Material[]> } {
  return { counts: columnCounts(snapshot.editorial, data.open), cards: columnCards(data.verified, data.open, limit) };
}
