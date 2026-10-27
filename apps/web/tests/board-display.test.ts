import { describe, expect, it } from "vitest";
import { boardOrder, rose, rotation, wallClock } from "../src/lib/board";
import type { Material } from "../src/lib/types";
import { material } from "./fixtures";

const card = (i: number, priority: Material["priority"], at: string): Material => ({ ...material(i), priority, created_at: at });

describe("supervisor board display helpers (#385)", () => {
  it("orders a column urgent, then important, then oldest first", () => {
    const items = [card(1, "normal", "2026-10-26T09:00:00Z"), card(2, "urgent", "2026-10-26T10:00:00Z"), card(3, "important", "2026-10-26T08:00:00Z"), card(4, "urgent", "2026-10-26T09:30:00Z")];
    expect(boardOrder(items).map(m => m.id)).toEqual([items[3].id, items[1].id, items[2].id, items[0].id]);
  });
  it("rotates eight cards at a time and wraps around", () => {
    const items = Array.from({ length: 19 }, (_, i) => card(i + 1, "normal", "2026-10-26T09:00:00Z"));
    expect(rotation(items, 0)).toMatchObject({ page: 0, pages: 3 }); expect(rotation(items, 0).shown).toHaveLength(8);
    expect(rotation(items, 2).shown).toHaveLength(3); expect(rotation(items, 3).page).toBe(0);
    expect(rotation([], 5)).toMatchObject({ page: 0, pages: 1, shown: [] });
  });
  it("sounds only when urgent or overdue counts rise, never on the first snapshot", () => {
    expect(rose(null, { urgent_open: 3, overdue_acknowledgements: 1 })).toBe(false);
    expect(rose({ urgent_open: 3, overdue_acknowledgements: 1 }, { urgent_open: 3, overdue_acknowledgements: 1 })).toBe(false);
    expect(rose({ urgent_open: 3, overdue_acknowledgements: 1 }, { urgent_open: 2, overdue_acknowledgements: 2 })).toBe(true);
    expect(rose({ urgent_open: 3, overdue_acknowledgements: 1 }, { urgent_open: 4, overdue_acknowledgements: 0 })).toBe(true);
  });
  it("prints the wall clock as HH:MM:SS", () => { expect(wallClock(new Date(2026, 9, 26, 7, 5, 9).getTime())).toBe("07:05:09"); });
});

it("derives overdue age only from the returned deadline, with null and future dates absent", async () => {
  const { overdueTime } = await import("../src/lib/board");
  const now = Date.parse("2026-10-27T10:02:03Z");
  expect(overdueTime("2026-10-27T10:00:00Z", now)).toBe("02:03");
  for (const value of [null, undefined, "invalid", "2026-10-27T10:03:00Z"]) expect(overdueTime(value, now)).toBeNull();
});
