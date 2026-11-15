import { describe, expect, it } from "vitest";
import { movements, safeEntry, twoDecimals, type EarningsEntry } from "../src/lib/earnings-policy";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });
const line = (over: Partial<EarningsEntry>): EarningsEntry => ({ id: "1", entry_id: "e1", kind: "sale", state: "pending", amount: usd(7000), reference_type: "order", reference_id: "o1", occurred_at: "2026-11-01T10:00:00Z", ...over });

describe("the reporter statement (coordinator decision 2026-11-15)", () => {
  it("shows one line per movement: a transfer between states is one line at its destination, with where it came from", () => {
    const list = movements([
      line({ id: "9", entry_id: "pay", kind: "payout", state: "in_payout", amount: usd(5000) }), line({ id: "8", entry_id: "pay", kind: "payout", state: "available", amount: usd(-5000) }),
      line({ id: "7", entry_id: "rel", kind: "release", state: "available", amount: usd(7000) }), line({ id: "6", entry_id: "rel", kind: "release", state: "pending", amount: usd(-7000) }),
      line({ id: "5", entry_id: "back", kind: "refund", state: "available", amount: usd(-2000) }), line({ id: "4", entry_id: "back", kind: "refund", state: "pending", amount: usd(-1000) }),
      line({ id: "3", entry_id: "sale", kind: "sale", state: "pending", amount: usd(7000) }),
    ]);
    expect(list.map(m => [m.kind, m.state, m.from, m.amount.amount_minor])).toEqual([["payout", "in_payout", "available", 5000], ["release", "available", "pending", 7000], ["refund", "available", null, -3000], ["sale", "pending", null, 7000]]);
  });
  it("passes what a sale line sold and when it is released, and drops anything else in it", () => {
    const sale = { sold_at: "2026-11-01T10:00:00Z", items: [{ material_id: "20000000-0000-4000-8000-000000000001", title: "تقرير", license_type: "editorial_single", share: usd(7000), buyer: "canary" }], organization_id: "canary" };
    const safe = safeEntry(line({ sale, releases_at: "2026-11-15T10:00:00Z" } as unknown as Partial<EarningsEntry>));
    expect(safe.sale).toEqual({ sold_at: "2026-11-01T10:00:00Z", items: [{ material_id: "20000000-0000-4000-8000-000000000001", title: "تقرير", license_type: "editorial_single", share: usd(7000) }] });
    expect(safe.releases_at).toBe("2026-11-15T10:00:00Z"); expect(JSON.stringify(safe)).not.toContain("canary");
    expect(safeEntry(line({})).sale).toBeNull(); expect(safeEntry(line({})).releases_at).toBeNull();
  });
  it("takes an amount with two decimals at most, never rounding it silently", () => {
    for (const ok of ["100", "100.5", "100.55", " 7.10 "]) expect(twoDecimals(ok)).toBe(true);
    for (const bad of ["100.555", "1e3", "", "-5", "1,5", "abc"]) expect(twoDecimals(bad)).toBe(false);
  });
  it("names the reporter's part a share, not a commission, in both languages", () => {
    expect(ar.earnings.formula).not.toContain("العمولة ×"); expect(ar.earnings.formula).not.toContain("نسبة العمولة"); expect(en.earnings.formula.toLowerCase()).not.toContain("commission rate");
    for (const key of ["releasesOn", "belowMinimum", "twoDecimals", "fromState"] as const) { expect(ar.earnings[key]).toBeTruthy(); expect(en.earnings[key]).toBeTruthy(); }
  });
});
