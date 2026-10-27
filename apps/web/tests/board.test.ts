import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { safeDashboard } from "../src/lib/privacy";
import { elapsed } from "../src/components/newsroom-board";
import { columnCards, columnCounts, countText, editorialStates, isExact, productionColumn, productionColumns, technicalOffTrack, unfetchedItems, verifiedQueries, type ColumnCount, type ProductionColumn } from "../src/lib/board-columns";
import { arrange, fetchCap, fetchPages, maxPages, pageSize } from "../src/lib/board-load";
import ar from "../messages/ar.json";
import en from "../messages/en.json";
import type { Material, NewsroomDashboard } from "../src/lib/types";

const id = "20000000-0000-4000-8000-000000000001";
describe("newsroom board", () => {
  it("keeps only contract states, ids and numbers from the snapshot", () => {
    const raw = { generated_at: "2026-10-21T10:00:00Z", urgent_open: 3, overdue_acknowledgements: 1, editorial: [{ state: "inbox", count: 4 }, { state: "canary", count: 1 }], technical: [{ state: "verified", count: 2 }], rights: [],
      reserved: [{ material_id: id, reserved_by: id, reserved_at: "2026-10-21T10:00:00Z", priority: "urgent", editorial_state: "in_production", title: "canary" }, { material_id: "bad", reserved_by: id, reserved_at: "x", priority: "normal", editorial_state: "inbox" }],
      recent_receipts: [{ material_id: id, receipt_number: "R-261021-000001", verified_at: "2026-10-21T10:00:00Z", priority: "normal", reporter: "canary" }], extra: "canary" } as unknown as NewsroomDashboard;
    const safe = safeDashboard(raw);
    expect(JSON.stringify(safe)).not.toContain("canary"); expect(safe.editorial).toEqual([{ state: "inbox", count: 4 }]); expect(safe.reserved).toHaveLength(1);
    expect(safe).not.toHaveProperty("uploads_in_progress");
    const progress = safeDashboard({ ...raw, uploads_in_progress: [{ upload_session_id: id, material_id: id, kind: "original", priority: "urgent", state: "in_progress", size_bytes: 100, bytes_received: 150, updated_at: "2026-10-21T10:00:00Z", filename: "canary" }, { upload_session_id: "bad", material_id: id, kind: "proxy", priority: "normal", state: "created", size_bytes: 1, bytes_received: 0, updated_at: "x" }] } as unknown as NewsroomDashboard);
    expect(progress.uploads_in_progress).toHaveLength(1); expect(progress.uploads_in_progress![0].bytes_received).toBe(100); expect(JSON.stringify(progress)).not.toContain("canary");
  });
  it("formats elapsed time", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(elapsed("2026-10-21T11:55:00Z", now, "en")).toBe("5 min"); expect(elapsed("2026-10-21T09:00:00Z", now, "en")).toBe("3 h"); expect(elapsed("2026-10-19T12:00:00Z", now, "ar")).toBe("2 ي");
  });
});

// ADR 0078: أعمدة لوحة الإنتاج الأربعة (Figma 193:862) من الحالتين التحريرية والفنية، بأولوية: منشورة خارج اللوحة ثم متوقفة ثم قيد التحقق ثم جاهزة/واردة.
const card = (n: number, editorial_state: Material["editorial_state"], technical_state: Material["technical_state"], priority: Material["priority"] = "normal", created = `2026-10-21T10:${String(10 + n).padStart(2, "0")}:00Z`) =>
  ({ id: `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`, editorial_state, technical_state, priority, created_at: created }) as Material;

describe("production board columns (four, ADR 0078)", () => {
  it("is exactly the four columns of the design, in start-to-end order", () => {
    expect(productionColumns).toEqual(["incoming", "checking", "ready", "stalled"]);
    expect(productionColumns.map(c => ar.board.columns[c])).toEqual(["واردة", "قيد التحقق", "جاهزة للنشر", "متوقفة"]);
    expect(Object.keys(en.board.columns)).toEqual([...productionColumns]); expect(Object.keys(ar.board.columnHelp)).toEqual([...productionColumns]); expect(Object.keys(en.board.columnHelp)).toEqual([...productionColumns]);
  });
  it("maps every editorial and technical state pair as documented, including the overlaps", () => {
    const table: Record<string, Record<string, ProductionColumn | null>> = {
      //                  pending     proxy_received original_received verified     failed
      inbox:         { pending: "checking", proxy_received: "checking", original_received: "checking", verified: "incoming", failed: "stalled" },
      acknowledged:  { pending: "checking", proxy_received: "checking", original_received: "checking", verified: "checking", failed: "stalled" },
      reviewing:     { pending: "checking", proxy_received: "checking", original_received: "checking", verified: "checking", failed: "stalled" },
      needs_changes: { pending: "stalled", proxy_received: "stalled", original_received: "stalled", verified: "stalled", failed: "stalled" },
      accepted:      { pending: "checking", proxy_received: "checking", original_received: "checking", verified: "ready", failed: "stalled" },
      in_production: { pending: "checking", proxy_received: "checking", original_received: "checking", verified: "ready", failed: "stalled" },
      final_review:  { pending: "checking", proxy_received: "checking", original_received: "checking", verified: "ready", failed: "stalled" },
      published:     { pending: null, proxy_received: null, original_received: null, verified: null, failed: null },
      rejected:      { pending: "stalled", proxy_received: "stalled", original_received: "stalled", verified: "stalled", failed: "stalled" },
    };
    expect(Object.keys(table)).toEqual([...editorialStates]);
    for (const [editorial, row] of Object.entries(table)) for (const [technical, expected] of Object.entries(row)) expect(productionColumn(editorial as Material["editorial_state"], technical as Material["technical_state"]), `${editorial} + ${technical}`).toBe(expected);
    // الأولويتان الصريحتان: الفشل الفني يغلب القبول، وعدم اكتمال الاستلام يغلب القبول فلا تُعدّ جاهزة قبل التحقق.
    expect(productionColumn("accepted", "failed")).toBe("stalled"); expect(productionColumn("accepted", "original_received")).toBe("checking");
  });
  it("queries verified cards per editorial state and fetches every off-track technical state in full", () => {
    expect(verifiedQueries).toEqual([{ state: "inbox", column: "incoming" }, { state: "acknowledged", column: "checking" }, { state: "reviewing", column: "checking" }, { state: "needs_changes", column: "stalled" }, { state: "accepted", column: "ready" }, { state: "in_production", column: "ready" }, { state: "final_review", column: "ready" }, { state: "rejected", column: "stalled" }]);
    expect(technicalOffTrack).toEqual(["pending", "proxy_received", "original_received", "failed"]);
  });
  it("counts exactly from the per-track snapshot plus the full off-track set", () => {
    // 20 صندوق وارد: 2 منها بلا تحقق فني (واحدة جارية وواحدة فاشلة) + 3 مقبولة منها فاشلة وجارية + 4 قيد المراجعة + 2 تحتاج تعديلًا + 1 مرفوضة + 5 منشورة.
    const editorial = [{ state: "inbox", count: 20 }, { state: "accepted", count: 3 }, { state: "reviewing", count: 4 }, { state: "needs_changes", count: 2 }, { state: "rejected", count: 1 }, { state: "published", count: 5 }, { state: "canary", count: 9 }];
    const open = [card(1, "inbox", "pending"), card(2, "inbox", "failed"), card(3, "accepted", "failed"), card(4, "accepted", "original_received"), card(5, "needs_changes", "failed"), card(6, "published", "failed")];
    const exact = (value: Record<ProductionColumn, ColumnCount>) => { for (const c of productionColumns) expect(isExact(value[c]), c).toBe(true); return Object.fromEntries(productionColumns.map(c => [c, value[c].count])); };
    expect(exact(columnCounts(editorial, open))).toEqual({ incoming: 18, checking: 4 + 1 + 1, ready: 1, stalled: 1 + 1 + 2 + 1 });
    expect(exact(columnCounts([], []))).toEqual({ incoming: 0, checking: 0, ready: 0, stalled: 0 });
    // لقطة أقدم من الجلب لا تُنتج عدّادًا سالبًا.
    expect(columnCounts([{ state: "inbox", count: 0 }], [card(1, "inbox", "pending")]).incoming.count).toBe(0);
  });
  it("places each card once, in its column, urgent first then oldest, trimmed to the limit", () => {
    const verified = [card(1, "inbox", "verified"), card(2, "inbox", "verified", "urgent", "2026-10-21T11:00:00Z"), card(3, "reviewing", "verified"), card(4, "accepted", "verified"), card(5, "rejected", "verified"), card(6, "published", "verified")];
    const open = [card(7, "accepted", "failed"), card(8, "inbox", "proxy_received"), card(1, "inbox", "verified")];
    const cards = columnCards(verified, open, 2), ids = (c: ProductionColumn) => cards[c].map(item => Number(item.id.slice(-12)));
    expect(ids("incoming")).toEqual([2, 1]); expect(ids("checking")).toEqual([3, 8]); expect(ids("ready")).toEqual([4]); expect(ids("stalled")).toEqual([5, 7]);
    expect(Object.values(cards).flat().map(c => c.id).filter(id => id.endsWith("000000000006"))).toEqual([]);
  });
});


// سقف الجلب: 100 × 5 صفحات لكل حالة فنية غير مكتملة. ما بعده لا يُحسب في عمود خطأ، بل يُعلَن العدّاد حدًّا أدنى.
const rows = (from: number, count: number, editorial: Material["editorial_state"], technical: Material["technical_state"]) => Array.from({ length: count }, (_, i) => card(from + i, editorial, technical));
/** خادم اصطناعي: يرد صفحات بمؤشر رقمي من القائمة المصفّاة بالحالة الفنية، ويسجل الاستدعاءات. */
function fakeApi(all: Material[]) {
  const calls: { technical?: string; editorial?: string; cursor?: string; limit?: number }[] = [];
  const GET = vi.fn(async (_path: string, init: { params: { query: { technical_state?: string; editorial_state?: string; cursor?: string; limit?: number } } }) => {
    const q = init.params.query; calls.push({ technical: q.technical_state, editorial: q.editorial_state, cursor: q.cursor, limit: q.limit });
    const filtered = all.filter(m => (!q.technical_state || m.technical_state === q.technical_state) && (!q.editorial_state || m.editorial_state === q.editorial_state));
    const start = Number(q.cursor ?? 0), limit = q.limit ?? 50;
    return { data: { items: filtered.slice(start, start + limit), next_cursor: start + limit < filtered.length ? String(start + limit) : null }, response: { ok: true, status: 200 } };
  });
  return { GET, calls };
}
const snapshotOf = (all: Material[]): NewsroomDashboard => {
  const tally = (key: "editorial_state" | "technical_state") => Object.entries(all.reduce<Record<string, number>>((n, m) => ({ ...n, [m[key]]: (n[m[key]] ?? 0) + 1 }), {})).map(([state, count]) => ({ state, count }));
  return { generated_at: "2026-10-27T10:00:00Z", urgent_open: 0, overdue_acknowledgements: 0, editorial: tally("editorial_state"), technical: tally("technical_state"), rights: [], reserved: [], recent_receipts: [] } as unknown as NewsroomDashboard;
};

describe("board paging and the fetch cap (honest counts beyond 500 per technical state)", () => {
  it("pages through by cursor until the end, and is not truncated when it ends within the bound", async () => {
    const items = rows(1, 250, "inbox", "pending"), api = fakeApi(items);
    const result = await fetchPages(async cursor => (await api.GET("/materials", { params: { query: { technical_state: "pending", limit: pageSize, ...(cursor ? { cursor } : {}) } } })).data);
    expect(result.items.map(m => m.id)).toEqual(items.map(m => m.id)); expect(result.truncated).toBe(false);
    expect(api.calls.map(c => c.cursor)).toEqual([undefined, "100", "200"]);
  });
  it("is complete, not truncated, when exactly the cap is returned and no page follows", async () => {
    const api = fakeApi(rows(1, fetchCap, "inbox", "pending"));
    const result = await fetchPages(async cursor => (await api.GET("/materials", { params: { query: { technical_state: "pending", limit: pageSize, ...(cursor ? { cursor } : {}) } } })).data);
    expect(result.items).toHaveLength(fetchCap); expect(result.truncated).toBe(false); expect(api.calls).toHaveLength(maxPages);
  });
  it("stops at the bound and says it was truncated when a page still follows", async () => {
    const api = fakeApi(rows(1, fetchCap + 1, "inbox", "pending"));
    const result = await fetchPages(async cursor => (await api.GET("/materials", { params: { query: { technical_state: "pending", limit: pageSize, ...(cursor ? { cursor } : {}) } } })).data);
    expect(result.items).toHaveLength(fetchCap); expect(result.truncated).toBe(true); expect(api.calls).toHaveLength(maxPages);
    expect(fetchCap).toBe(500);
  });
  it("loadBoard records exactly the technical states that hit the cap and never requests past it", async () => {
    const all = [...rows(1, 700, "inbox", "pending"), ...rows(1001, 40, "accepted", "failed"), ...rows(2001, 30, "inbox", "verified")], api = fakeApi(all);
    vi.resetModules(); vi.doMock("../src/lib/browser-api", () => ({ browserApi: () => ({ GET: api.GET }), dataOrThrow: <T,>(r: { data?: T }) => r.data }));
    const { loadBoard: load } = await import("../src/lib/board-load");
    const data = await load(new AbortController().signal, 20);
    vi.doUnmock("../src/lib/browser-api");
    expect(data.truncated).toEqual(["pending"]); expect(data.open.filter(m => m.technical_state === "pending")).toHaveLength(fetchCap); expect(data.open.filter(m => m.technical_state === "failed")).toHaveLength(40);
    expect(api.calls.filter(c => c.technical === "pending")).toHaveLength(maxPages); expect(api.calls.every(c => (c.limit ?? 0) <= pageSize)).toBe(true);
  });
  it("does not count the unfetched rest in the wrong columns: 700 unverified inbox items beyond a 500 cap", async () => {
    const all = [...rows(1, 700, "inbox", "pending"), ...rows(2001, 30, "inbox", "verified")], snapshot = snapshotOf(all);
    const data = { verified: rows(2001, 20, "inbox", "verified"), open: all.slice(0, fetchCap), truncated: ["pending"] as const };
    const { counts, capped } = arrange(snapshot, { ...data, truncated: [...data.truncated] }, 20);
    // الحقيقة: 30 واردة و700 قيد التحقق. الحساب القديم كان يعدّ 230 واردة (700 − 500 يُضاف خطأً إلى 30).
    expect(capped).toBe(true);
    expect(counts.incoming).toEqual({ count: 30, upper: 230 }); expect(counts.checking).toEqual({ count: 500, upper: 700 });
    expect(counts.ready).toEqual({ count: 0, upper: 0 }); expect(counts.stalled).toEqual({ count: 0, upper: 200 });
    for (const c of productionColumns) { const truth = { incoming: 30, checking: 700, ready: 0, stalled: 0 }[c]; expect(counts[c].count, `${c} lower`).toBeLessThanOrEqual(truth); expect(counts[c].upper, `${c} upper`).toBeGreaterThanOrEqual(truth); }
    expect(countText(counts.incoming)).toMatch(/30\+/); expect(countText({ count: 5, upper: 5 })).toBe("5");
  });
  it("derives what was left unfetched from the per-track snapshot, at least one when the cap was hit", () => {
    const open = rows(1, 500, "inbox", "pending");
    expect(unfetchedItems([{ state: "pending", count: 720 }], open, ["pending"])).toEqual({ processing: 220, failed: 0 });
    expect(unfetchedItems([{ state: "pending", count: 400 }], open, ["pending"])).toEqual({ processing: 1, failed: 0 });
    expect(unfetchedItems([], open, ["failed"])).toEqual({ processing: 0, failed: 1 });
    expect(unfetchedItems([{ state: "pending", count: 720 }], open, [])).toEqual({ processing: 0, failed: 0 });
  });
  it("always brackets the true column counts, and is exact whenever nothing was left out (randomised)", () => {
    let seed = 20261027; const next = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const technical = ["pending", "proxy_received", "original_received", "failed", "verified"] as const;
    for (let round = 0; round < 300; round++) {
      const all: Material[] = []; let n = 1;
      for (const editorial of editorialStates) for (const tech of technical) all.push(...rows((n += 1000), next(4) === 0 ? next(60) : next(6), editorial, tech));
      const snapshot = snapshotOf(all), open: Material[] = [], truncated: Material["technical_state"][] = [];
      for (const tech of technicalOffTrack) { const items = all.filter(m => m.technical_state === tech), keep = next(3) === 0 ? items.length : next(items.length + 1); open.push(...items.slice(0, keep)); if (keep < items.length) truncated.push(tech); }
      const counts = columnCounts(snapshot.editorial, open, unfetchedItems(snapshot.technical, open, truncated));
      const truth: Record<ProductionColumn, number> = { incoming: 0, checking: 0, ready: 0, stalled: 0 };
      for (const m of all) { const column = productionColumn(m.editorial_state, m.technical_state); if (column) truth[column]++; }
      for (const c of productionColumns) {
        expect(counts[c].count, `round ${round} ${c} lower`).toBeLessThanOrEqual(truth[c]); expect(counts[c].upper, `round ${round} ${c} upper`).toBeGreaterThanOrEqual(truth[c]);
        if (!truncated.length) expect(counts[c], `round ${round} ${c} exact`).toEqual({ count: truth[c], upper: truth[c] });
      }
    }
  });
});

describe("overflow label is the same wording for cards and uploads in progress", () => {
  it("uses one 'n more' resource per language", () => {
    expect(ar.board.display.more).toBe("{n} أخرى"); expect(en.board.display.more).toBe("{n} more");
    expect(ar.board.display.uploading).not.toContain("+"); expect(en.board.display.uploading).not.toContain("+");
  });
  it("renders the uploads overflow from board.display.more, with no hard-coded plus sign", () => {
    const source = readFileSync(new URL("../src/components/board-display.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/>\+\{/);
    const uses = source.match(/d\.more\.replace\("\{n\}"[^)]*\)/g) ?? [];
    expect(uses).toHaveLength(2); expect(uses.some(use => use.includes("uploads.length - uploadSlots"))).toBe(true);
  });
  it("explains the approximate counts in both languages", () => {
    for (const dict of [ar, en]) { expect(dict.board.countCapped).toContain("{n}"); expect(dict.board.atLeast.length).toBeGreaterThan(0); }
  });
});
