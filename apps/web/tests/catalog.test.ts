import { describe, expect, it } from "vitest";
import { catalogQuery, catalogRoles, licenseTypes, safeCatalogItem } from "../src/server/catalog";
import { catalogRoles as uiRoles } from "../src/components/store/store-catalog";
import type { CatalogItem } from "../src/lib/store-format";

const text = { ar: "ع", en: "E" };
const item = { listing_id: "71000000-0000-4000-8000-000000000001", material_version: 2, title: text, description: text, shot_list: [{ start_ms: 0, label: text, extra: "canary" }], material_types: ["report"], governorate: "غزة",
  shot_on: "2026-10-19T13:45:00Z", duration_ms: 1000, width: 1920, height: 1080, credit: "الشبكة", offers: [{ license_template_id: "70000000-0000-4000-8000-000000000001", license_version: 1, type: "editorial_single", name: text, price: { amount_minor: 100, currency: "USD", fx: "canary" } }],
  exclusive_available: true, listed_at: "2026-10-21T10:00:00Z", reporter_id: "canary", city: "canary", gps: { lat: 1, lng: 2 } } as unknown as CatalogItem;

describe("catalog BFF policy", () => {
  it("keeps the closed buyer view and cuts the shoot time to its day", () => {
    const safe = safeCatalogItem(item);
    expect(JSON.stringify(safe)).not.toMatch(/canary|"gps"|"lat"|13:45/); expect(safe.shot_on).toBe("2026-10-19"); expect(safe.offers[0].price).toEqual({ amount_minor: 100, currency: "USD" }); expect(safe.shot_list).toEqual([]);
  });
  it("accepts only the contract filters", () => {
    expect(catalogQuery(new URLSearchParams("q=غزة&material_type=report&material_type=aerial&min_height=1080&license_type=commercial&exclusive_available=true&shot_from=2026-10-01"))).toEqual({ q: "غزة", material_type: ["report", "aerial"], min_height: 1080, license_type: "commercial", exclusive_available: true, shot_from: "2026-10-01", limit: 24 });
    for (const bad of ["material_type=other", "license_type=resale", "shot_from=2026-10", "min_height=0", "exclusive_available=yes", "limit=101", "city=x", "q=%20"]) expect(() => catalogQuery(new URLSearchParams(bad))).toThrow();
  });
  it("uses one role list for the BFF and the sidebar", () => {
    expect([...uiRoles]).toEqual([...catalogRoles]); expect(licenseTypes).toHaveLength(4);
  });
});

it("passes versioned offer terms and day-only proof while excluding nested internal fields", async () => {
  const terms = { type: "editorial_single", name: text, terms: text, usage_media: ["tv"], territory: { kind: "worldwide", work_name: "canary" }, deliverables: ["original"], attribution: text, prohibitions: [], actor_name: "canary" };
  const raw = { ...item, actor_name: "canary", work_name: "canary", reserved_by_name: "canary", verified_on: "2026-10-27", editorial_approved_on: "2026-10-26", exclusive_unavailable_until: "2026-10-29T10:00:00Z", offers: [{ ...item.offers[0], terms }] } as unknown as CatalogItem;
  const safe = safeCatalogItem(raw);
  expect(safe.verified_on).toBe("2026-10-27"); expect(safe.editorial_approved_on).toBe("2026-10-26"); expect(safe.offers[0].terms?.terms).toEqual(text);
  expect(JSON.stringify(safe)).not.toMatch(/canary|actor_name|work_name/);
  const { formatDay } = await import("../src/lib/store-format");
  expect(formatDay("2026-10-27", "en")).not.toContain(":");
  for (const value of [null, undefined, "2026-02-30", "2026-10-27T10:00:00Z"]) expect(formatDay(value, "en")).toBeNull();
});
