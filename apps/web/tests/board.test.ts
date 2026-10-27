import { describe, expect, it } from "vitest";
import { safeDashboard } from "../src/lib/privacy";
import { elapsed } from "../src/components/newsroom-board";
import { columnCards, columnCounts, editorialStates, productionColumn, productionColumns, technicalOffTrack, verifiedQueries, type ProductionColumn } from "../src/lib/board-columns";
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
    expect(columnCounts(editorial, open)).toEqual({ incoming: 18, checking: 4 + 1 + 1, ready: 1, stalled: 1 + 1 + 2 + 1 });
    expect(columnCounts([], [])).toEqual({ incoming: 0, checking: 0, ready: 0, stalled: 0 });
    // لقطة أقدم من الجلب لا تُنتج عدّادًا سالبًا.
    expect(columnCounts([{ state: "inbox", count: 0 }], [card(1, "inbox", "pending")]).incoming).toBe(0);
  });
  it("places each card once, in its column, urgent first then oldest, trimmed to the limit", () => {
    const verified = [card(1, "inbox", "verified"), card(2, "inbox", "verified", "urgent", "2026-10-21T11:00:00Z"), card(3, "reviewing", "verified"), card(4, "accepted", "verified"), card(5, "rejected", "verified"), card(6, "published", "verified")];
    const open = [card(7, "accepted", "failed"), card(8, "inbox", "proxy_received"), card(1, "inbox", "verified")];
    const cards = columnCards(verified, open, 2), ids = (c: ProductionColumn) => cards[c].map(item => Number(item.id.slice(-12)));
    expect(ids("incoming")).toEqual([2, 1]); expect(ids("checking")).toEqual([3, 8]); expect(ids("ready")).toEqual([4]); expect(ids("stalled")).toEqual([5, 7]);
    expect(Object.values(cards).flat().map(c => c.id).filter(id => id.endsWith("000000000006"))).toEqual([]);
  });
});

