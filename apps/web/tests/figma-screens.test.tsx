import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrackLegend, TrackLine, trackSentence } from "../src/components/track-line";
import { flaggedTracks, segmentState, trackOrder } from "../src/lib/tracks";
import { activeTab, inboxTabs, isOpenUrgent, matchesSearch, tabCounts, tabQuery } from "../src/lib/inbox-tabs";
import { humanDuration, longDate, shortTime } from "../src/lib/i18n";
import { wallDate } from "../src/lib/board";
import { catalogParams, periodStart } from "../src/components/store/store-catalog";
import { CatalogCard, licenseFamilies } from "../src/components/store/catalog-card";
import type { NewsroomDashboard } from "../src/lib/types";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const tracks = (technical_state: Parameters<typeof segmentState<"technical_state">>[1], editorial_state: Parameters<typeof segmentState<"editorial_state">>[1], rights_state: Parameters<typeof segmentState<"rights_state">>[1]) => ({ technical_state, editorial_state, rights_state });

describe("track line (Figma 166:89, 193:590)", () => {
  it("maps every contract state to a segment and never moves backwards along a track", () => {
    expect(segmentState("technical_state", "pending")).toBe("empty"); expect(segmentState("technical_state", "original_received")).toBe("progress");
    expect(segmentState("technical_state", "verified")).toBe("done"); expect(segmentState("technical_state", "failed")).toBe("blocked");
    expect(segmentState("editorial_state", "needs_changes")).toBe("attention"); expect(segmentState("editorial_state", "rejected")).toBe("blocked");
    expect(["accepted", "in_production", "final_review", "published"].map(s => segmentState("editorial_state", s as "accepted"))).toEqual(["done", "done", "done", "done"]);
    expect(segmentState("rights_state", "unknown")).toBe("empty"); expect(segmentState("rights_state", "documented")).toBe("progress"); expect(segmentState("rights_state", "sellable")).toBe("done");
    expect(segmentState("rights_state", "withdrawn")).toBe("blocked");
    expect(trackOrder).toEqual(["technical_state", "editorial_state", "rights_state"]);
  });
  it("reads as one sentence for screen readers, in both languages", () => {
    expect(trackSentence(tracks("verified", "reviewing", "unknown"), "ar")).toBe("الفنية مكتملة، التحريرية جارية، الحقوق لم تبدأ");
    expect(trackSentence(tracks("verified", "reviewing", "unknown"), "en")).toBe("Technical complete, Editorial in progress, Rights not started");
  });
  it("renders three independent segments with the state in the markup, not only in colour", () => {
    const html = renderToStaticMarkup(<TrackLine material={tracks("failed", "needs_changes", "documented")} locale="ar" note />);
    expect([...html.matchAll(/data-track="(\w+)" data-state="(\w+)"/g)].map(m => `${m[1]}:${m[2]}`)).toEqual(["technical_state:blocked", "editorial_state:attention", "rights_state:progress"]);
    expect(html).toContain('role="img"'); expect(html).toContain("الفنية متوقفة، التحريرية تحتاج انتباهاً، الحقوق جارية");
    expect(html).toContain(`فنية: ${ar.states.technical_state.failed}`); expect(html).toContain(`تحريرية: ${ar.states.editorial_state.needs_changes}`);
    expect(renderToStaticMarkup(<TrackLine material={tracks("verified", "accepted", "sellable")} locale="en" note />)).not.toContain("track-note");
    expect(flaggedTracks(tracks("verified", "rejected", "blocked")).map(f => f.track)).toEqual(["editorial_state", "rights_state"]);
  });
  it("draws the wall legend with all five states in start-to-end order", () => {
    const html = renderToStaticMarkup(<TrackLegend locale="ar" />);
    expect([...html.matchAll(/data-state="(\w+)"/g)].map(m => m[1])).toEqual(["empty", "progress", "done", "attention", "blocked"]);
    expect(html).toContain(ar.trackLine.legend);
  });
});

describe("inbox quick filters (Figma 193:620)", () => {
  const snapshot = { editorial: [{ state: "inbox", count: 7 }, { state: "reviewing", count: 3 }, { state: "accepted", count: 2 }, { state: "published", count: 5 }], technical: [{ state: "failed", count: 1 }, { state: "pending", count: 4 }], urgent_open: 3 } as unknown as NewsroomDashboard;
  it("counts only what the dashboard returns", () => {
    expect(tabCounts(snapshot)).toEqual({ all: 17, urgent: 3, inbox: 7, reviewing: 3, accepted: 2, stopped: 1 });
    expect(tabCounts({ ...snapshot, editorial: [], technical: [], urgent_open: 0 })).toEqual({ all: 0, urgent: 0, inbox: 0, reviewing: 0, accepted: 0, stopped: 0 });
  });
  it("recognises the tab that equals the current query and nothing for a custom filter", () => {
    for (const tab of inboxTabs) expect(activeTab({ limit: 50, ...tabQuery[tab] })).toBe(tab);
    expect(activeTab({ limit: 50, priority: "urgent", editorial_state: "inbox" })).toBeNull(); expect(activeTab({ limit: 50, governorate: "غزة" })).toBeNull();
    expect(activeTab({ limit: 50, cursor: "next" })).toBe("all");
  });
  it("keeps closed urgent material out of the urgent tab so it matches the open-urgent count", () => {
    expect(isOpenUrgent({ priority: "urgent", editorial_state: "inbox" })).toBe(true); expect(isOpenUrgent({ priority: "urgent", editorial_state: "published" })).toBe(false);
    expect(isOpenUrgent({ priority: "urgent", editorial_state: "rejected" })).toBe(false); expect(isOpenUrgent({ priority: "normal", editorial_state: "inbox" })).toBe(false);
  });
  it("searches the loaded page by title, governorate or receipt, ignoring case and blanks", () => {
    expect(matchesSearch("", ["x"])).toBe(true); expect(matchesSearch("  rcpt-0004 ", ["عنوان", "غزة", "RCPT-0004"])).toBe(true);
    expect(matchesSearch("غزة", ["عنوان", "غزة", null])).toBe(true); expect(matchesSearch("zzz", ["عنوان", "غزة", undefined])).toBe(false);
  });
});

describe("Figma date and duration copy", () => {
  it("prints the long date with Levantine month names and Latin digits", () => {
    expect(longDate("2026-10-26T12:00:00Z", "ar")).toBe("26 تشرين الأول 2026"); expect(longDate("2026-10-26T12:00:00Z", "en")).toBe("October 26, 2026");
    expect(longDate(null, "ar")).toBe(ar.notAvailable); expect(shortTime("bad")).toBe("");
    expect(wallDate(Date.UTC(2026, 9, 27, 12), "ar")).toContain("27 تشرين الأول 2026");
  });
  it("names a duration with its largest whole unit", () => {
    expect(humanDuration(240000, "ar")).toBe("4 دقائق"); expect(humanDuration(60000, "ar")).toBe("دقيقة"); expect(humanDuration(30000, "ar")).toBe("30 ثانية");
    expect(humanDuration(3 * 3600000, "ar")).toBe("3 ساعات"); expect(humanDuration(2 * 86400000, "en")).toBe("2 days"); expect(humanDuration(-5, "en")).toBe("0 seconds");
  });
});

describe("catalog toolbar (Figma 185:330)", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  it("turns a period into the contract's shot_from date, by whole days", () => {
    expect(periodStart("recent", now)).toBe("2026-10-26"); expect(periodStart("week", now)).toBe("2026-10-21"); expect(periodStart("month", now)).toBe("2026-09-28"); expect(periodStart("", now)).toBeNull();
    expect(catalogParams({ period: "week" }, now).get("shot_from")).toBe("2026-10-21"); expect(catalogParams({ period: "week" }, now).has("period")).toBe(false);
    expect(catalogParams({ period: "week", shot_from: "2026-10-01" }, now).get("shot_from")).toBe("2026-10-01");
  });
  it("summarises licence families, with exclusivity only when it is available now", () => {
    expect(licenseFamilies(["editorial_single", "editorial_term", "exclusive_temporary"], true, "ar")).toEqual(["تحريري", ar.store.browse.exclusive]);
    expect(licenseFamilies(["editorial_single", "exclusive_temporary", "commercial"], false, "en")).toEqual(["Editorial", "Commercial"]);
    expect(licenseFamilies([], true, "en")).toEqual([]);
  });
  it("lays the card out as thumbnail, title, meta, credit and a price row without identifiers", () => {
    const html = renderToStaticMarkup(<CatalogCard locale="ar" item={{ href: "/ar/store/x", title: { ar: "عنوان", en: "Title" }, governorate: "غزة", shotOn: "2026-10-26", durationMs: 134000, width: 1920, height: 1080, displayName: "فلسطين بوست", from: { amount_minor: 12000, currency: "USD" }, types: ["raw_footage"], licenses: ["editorial_single", "exclusive_temporary"], exclusive: true }} />);
    expect(html).toContain("26 تشرين الأول 2026"); expect(html).toContain("2:14"); expect(html).toContain(ar.store.browse.startsAt); expect(html).toContain("تحريري، حصرية متاحة"); expect(html).toContain("thumb-play");
    expect(html).not.toMatch(/RCPT|VL-\d|sha256|[0-9a-f]{32}/i);
  });
  it("has Arabic and English copy for every new key", () => {
    const keys = (value: unknown, prefix = ""): string[] => value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix];
    for (const part of ["trackLine", "inboxTabs", "inboxSearch"] as const) expect(keys(ar[part])).toEqual(keys(en[part]));
    expect(keys(ar.store.browse.period)).toEqual(keys(en.store.browse.period)); expect(keys(ar.store.browse.quick)).toEqual(keys(en.store.browse.quick));
    for (const text of [ar.inboxSummary, en.inboxSummary]) for (const slot of ["{total}", "{urgent}", "{inbox}", "{reviewing}", "{accepted}", "{stopped}"]) expect(text).toContain(slot);
  });
});
