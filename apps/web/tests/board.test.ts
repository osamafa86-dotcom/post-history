import { describe, expect, it } from "vitest";
import { safeDashboard } from "../src/lib/privacy";
import { elapsed, boardColumns } from "../src/components/newsroom-board";
import type { NewsroomDashboard } from "../src/lib/types";

const id = "20000000-0000-4000-8000-000000000001";
describe("newsroom board", () => {
  it("keeps only contract states, ids and numbers from the snapshot", () => {
    const raw = { generated_at: "2026-10-21T10:00:00Z", urgent_open: 3, overdue_acknowledgements: 1, editorial: [{ state: "inbox", count: 4 }, { state: "canary", count: 1 }], technical: [{ state: "verified", count: 2 }], rights: [],
      reserved: [{ material_id: id, reserved_by: id, reserved_at: "2026-10-21T10:00:00Z", priority: "urgent", editorial_state: "in_production", title: "canary" }, { material_id: "bad", reserved_by: id, reserved_at: "x", priority: "normal", editorial_state: "inbox" }],
      recent_receipts: [{ material_id: id, receipt_number: "R-261021-000001", verified_at: "2026-10-21T10:00:00Z", priority: "normal", reporter: "canary" }], extra: "canary" } as unknown as NewsroomDashboard;
    const safe = safeDashboard(raw);
    expect(JSON.stringify(safe)).not.toContain("canary"); expect(safe.editorial).toEqual([{ state: "inbox", count: 4 }]); expect(safe.reserved).toHaveLength(1);
  });
  it("orders the plan's columns and formats elapsed time", () => {
    expect(boardColumns).toEqual(["inbox", "reviewing", "accepted", "in_production", "final_review", "published"]);
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(elapsed("2026-10-21T11:55:00Z", now, "en")).toBe("5 min"); expect(elapsed("2026-10-21T09:00:00Z", now, "en")).toBe("3 h"); expect(elapsed("2026-10-19T12:00:00Z", now, "ar")).toBe("2 ي");
  });
});
