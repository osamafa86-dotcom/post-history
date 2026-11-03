import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";
import { cleanText, codePoints, fill, initialsOf, stripHidden, validText } from "../src/lib/admin-text";
import { editDistance, expectedMode, mergeHint, moveTag, rewriteInput, safeSuggestions, suggestionsInput, tagUsageQuery, validTag } from "../src/lib/tag-policy";
import { capabilities, safeStaffPage, safeStaffUser, staffQuery } from "../src/lib/staff-policy";
import { platformInput } from "../src/lib/platform-policy";
import { basisPercent, contributorQuery, purchaseQuery, readiness, safeContributor, shiftMonth } from "../src/lib/finance-reports";

// لوحة الإدارة v2 (ADR 0102): قواعد النص والوسوم والمرشّحات والقوائم البيضاء، والـBFF للنقاط الجديدة (ADR 0098، 0099).
const hidden = { rlm: "\u200F", lri: "\u2066", nbsp: "\u00A0", nul: "\u0000", alm: "\u061C" };
const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });

describe("free text rule shared with MaterialTag and PlatformSettingsUpdate", () => {
  it("counts code points, refuses edge spaces and hidden characters, and cleans what a paste brings", () => {
    expect(validText("وسم", 40)).toBe(true); expect(validText("😀".repeat(40), 40)).toBe(true); expect(codePoints("😀😀")).toBe(2);
    expect(validText("a".repeat(41), 40)).toBe(false); expect(validText("", 40)).toBe(false);
    expect(validText(" وسم", 40)).toBe(false); expect(validText(`وسم${hidden.nbsp}`, 40)).toBe(false);
    for (const mark of [hidden.rlm, hidden.lri, hidden.nul, hidden.alm]) expect(validText(`و${mark}سم`, 40)).toBe(false);
    expect(stripHidden(`و${hidden.rlm}سم${hidden.lri}`)).toBe("وسم"); expect(cleanText(`  ${hidden.rlm}وسم `)).toBe("وسم");
    expect(fill("{a} و{b} و{c}", { a: 1, b: "x" })).toBe("1 وx و{c}"); expect(initialsOf("مراسل تجريبي")).toBe("مت"); expect(initialsOf(null, "?")).toBe("?");
  });
});

describe("tag administration (A2, ADR 0098)", () => {
  it("accepts the whole suggested list only: up to 50 valid tags without repeats and no other key", () => {
    expect(suggestionsInput({ tags: ["أ", "ب"] })).toEqual({ tags: ["أ", "ب"] });
    expect(suggestionsInput({ tags: ["أ", "أ"] })).toBeNull(); expect(suggestionsInput({ tags: Array.from({ length: 51 }, (_, i) => `t${i}`) })).toBeNull();
    expect(suggestionsInput({ tags: [" أ"] })).toBeNull(); expect(suggestionsInput({ tags: [], version: 3 })).toBeNull(); expect(suggestionsInput({ tags: [] })).toEqual({ tags: [] });
  });
  it("rewrites need two different valid tags; the expected mode is merge when the target is known", () => {
    expect(rewriteInput({ source: "مياة", target: "مياه" })).toEqual({ source: "مياة", target: "مياه" });
    expect(rewriteInput({ source: "مياه", target: "مياه" })).toBeNull(); expect(rewriteInput({ source: "مياه", target: "مياة", mode: "merge" })).toBeNull();
    expect(expectedMode("مياه", ["خيام", "مياه"])).toBe("merge"); expect(expectedMode("جديد", ["خيام"])).toBe("rename");
  });
  it("suggests a close suggested tag for a reporter's spelling, and moves without mutating", () => {
    expect(editDistance("مياة", "مياه")).toBe(1); expect(mergeHint("مياة", ["مدارس", "مياه"])).toBe("مياه"); expect(mergeHint("خيمة", ["خيام"])).toBe("خيام");
    expect(mergeHint("أب", ["تث"])).toBeNull(); expect(mergeHint("مياه", ["مياه"])).toBeNull();
    const list = ["a", "b", "c"]; expect(moveTag(list, 0, 2)).toEqual(["b", "c", "a"]); expect(list).toEqual(["a", "b", "c"]); expect(moveTag(list, 0, 5)).toEqual(list);
  });
  it("whitelists the usage query and refuses a list that would lose a tag when replaced", () => {
    expect(tagUsageQuery(new URLSearchParams("q=مي&suggested=false&limit=20"))).toEqual({ q: "مي", suggested: false, limit: 20 });
    expect(() => tagUsageQuery(new URLSearchParams("suggested=yes"))).toThrow(); expect(() => tagUsageQuery(new URLSearchParams("order=count"))).toThrow();
    expect(() => safeSuggestions({ tags: ["أ", " ب"], version: 2, updated_at: "2026-11-03T09:00:00Z" })).toThrow();
    expect(safeSuggestions({ tags: ["أ"], version: 2, updated_at: "2026-11-03T09:00:00Z", extra: "canary" } as never)).toEqual({ tags: ["أ"], version: 2, updated_at: "2026-11-03T09:00:00Z" });
  });
});

describe("staff accounts (A1, ADR 0099)", () => {
  it("repeats the role filter, refuses repeats and unknown values, and bounds the search", () => {
    expect(staffQuery(new URLSearchParams("role=reporter&role=supervisor&status=suspended&q=staff"))).toEqual({ limit: 50, role: ["reporter", "supervisor"], status: "suspended", q: "staff" });
    expect(() => staffQuery(new URLSearchParams("role=reporter&role=reporter"))).toThrow(); expect(() => staffQuery(new URLSearchParams("role=owner"))).toThrow();
    expect(() => staffQuery(new URLSearchParams("status=deleted"))).toThrow(); expect(() => staffQuery(new URLSearchParams(`q=${"x".repeat(81)}`))).toThrow(); expect(() => staffQuery(new URLSearchParams("q=a&q=b"))).toThrow();
  });
  it("drops email, legal name and devices even when a wrong server sends them, and a governorate with hidden marks", () => {
    const row = { id: randomUUID(), work_name: "مراسل تجريبي ١", roles: ["reporter", "owner"], governorate: `محافظة${hidden.rlm}`, status: "active", last_active_at: null, email: "x@example.test", reporter_legal_name: "canary" };
    expect(safeStaffUser(row as never)).toEqual({ id: row.id, work_name: "مراسل تجريبي ١", roles: ["reporter"], governorate: null, status: "active", last_active_at: null });
    const page = safeStaffPage({ items: [row as never, { ...row, id: "bad" } as never], next_cursor: null, summary: { total: 2, suspended: 0, roles: [{ role: "reporter", count: 2 }] } });
    expect(page.items).toHaveLength(1); expect(JSON.stringify(page)).not.toContain("@");
  });
  it("names an admin-only row in the role matrix", () => {
    expect(capabilities.find(row => row.key === "admin")?.roles).toEqual(["system_admin"]);
  });
});

describe("money reads and platform identity (A4, A5, A6)", () => {
  it("requires the month and year the contract requires", () => {
    expect(contributorQuery(new URLSearchParams("month=2026-11"))).toEqual({ month: "2026-11", limit: 100 });
    expect(() => contributorQuery(new URLSearchParams(""))).toThrow(); expect(() => contributorQuery(new URLSearchParams("month=2026-13"))).toThrow(); expect(() => contributorQuery(new URLSearchParams("month=2026-11&currency=EUR"))).toThrow();
    expect(purchaseQuery(new URLSearchParams("year=2026"))).toEqual({ year: 2026, limit: 100 }); expect(() => purchaseQuery(new URLSearchParams("year=1999"))).toThrow();
    expect(shiftMonth("2026-01", -1)).toBe("2025-12"); expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
  it("reads readiness from the current balance and writes the rate without hidden direction marks", () => {
    const balance = { currency: "USD" as const, pending: usd(0), available: usd(0), in_payout: usd(0), paid: usd(0), reserve: usd(0), requestable: usd(6000), minimum: usd(5000) };
    expect(readiness(balance)).toBe("ready"); expect(readiness({ ...balance, requestable: usd(100), in_payout: usd(900) })).toBe("in_payout"); expect(readiness({ ...balance, requestable: usd(100) })).toBe("below_minimum");
    expect(basisPercent(3000, "ar")).toBe("30%"); expect(basisPercent(3050, "en")).toBe("30.5%"); expect(basisPercent(null, "ar")).toBeNull();
    const row = { user_id: randomUUID(), work_name: "مراسل", currency: "USD" as const, sales: 1, gross: usd(100), fees_and_taxes: usd(0), net: usd(100), share: usd(30), refunded: usd(0), share_basis_points: 3000, balance, email: "x@example.test" };
    expect(safeContributor(row as never)).not.toHaveProperty("email"); expect(safeContributor({ ...row, share: { amount_minor: 30, currency: "ILS" } } as never)).toBeNull();
  });
  it("takes the three identity fields together, each by the free text rule and its length", () => {
    const body = { platform_name: "المكتبة المرئية", app_name: "ميدان بوست", watermark_text: "معاينة" };
    expect(platformInput(body)).toEqual(body); expect(platformInput({ ...body, app_name: "x".repeat(41) })).toBeNull(); expect(platformInput({ ...body, extra: "x" })).toBeNull(); expect(platformInput({ platform_name: "a", app_name: "b" })).toBeNull();
    expect(validTag("وسم")).toBe(true);
  });
});

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, supervisor: Me = { ...me, roles: [{ name: "supervisor", scopes: [] }] }, finance: Me = { ...me, roles: [{ name: "finance", scopes: [] }] };
async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "GET";
  const headers: Record<string, string> = { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers };
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? admin);
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}
const suggestions = { tags: ["أ", "ب"], version: 4, updated_at: "2026-11-03T09:00:00Z", canary: "never-display-canary" };

describe("BFF for the admin reads and writes", () => {
  it("lists staff for the system administrator only, forwards repeated roles and returns no email", async () => {
    const denied = await call("users", { user: supervisor }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
    const { result, calls } = await call("users?role=reporter&role=producer&q=staff", { upstream: () => Response.json({ items: [{ id: randomUUID(), work_name: null, roles: ["reporter"], governorate: null, status: "active", last_active_at: null, email: "x@example.test" }], next_cursor: null, summary: { total: 1, suspended: 0, roles: [] } }) });
    expect(result.status).toBe(200); const url = new URL(calls[0].url); expect(url.searchParams.getAll("role")).toEqual(["reporter", "producer"]); expect(url.searchParams.get("q")).toBe("staff");
    expect(await result.text()).not.toContain("@");
    expect((await call("users?email=x")).result.status).toBe(400);
  });
  it("reads the suggested list with its version as ETag, and refuses a replacement without If-Match", async () => {
    const read = await call("tag-suggestions", { user: supervisor, upstream: () => Response.json(suggestions, { headers: { ETag: '"999"' } }) });
    expect(read.result.headers.get("ETag")).toBe('"4"'); expect(await read.result.text()).not.toContain("canary");
    const missing = await call("tag-suggestions", { method: "PUT", body: { tags: ["أ"] } }); expect(missing.result.status).toBe(428); expect(missing.calls).toHaveLength(0);
    const supervisorWrite = await call("tag-suggestions", { method: "PUT", user: supervisor, body: { tags: ["أ"] }, headers: { "If-Match": '"4"' } }); expect(supervisorWrite.result.status).toBe(403);
  });
  it("forwards the whole list with the same key and revision, and passes 412 through for a reload", async () => {
    const key = randomUUID();
    const { result, calls } = await call("tag-suggestions", { method: "PUT", body: { tags: ["ب", "أ"] }, headers: { "If-Match": '"4"', "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual({ tags: ["ب", "أ"] }); return Response.json({ ...suggestions, tags: ["ب", "أ"], version: 5 }); } });
    expect(result.status).toBe(200); expect(result.headers.get("ETag")).toBe('"5"'); expect(calls[0].headers.get("If-Match")).toBe('"4"'); expect(calls[0].headers.get("Idempotency-Key")).toBe(key);
    const stale = await call("tag-suggestions", { method: "PUT", body: { tags: [] }, headers: { "If-Match": '"3"' }, upstream: () => Response.json({ message: "canary" }, { status: 412 }) });
    expect(stale.result.status).toBe(412); expect(await stale.result.json()).toEqual({ code: "precondition_failed" });
    const bad = await call("tag-suggestions", { method: "PUT", body: { tags: [`أ${hidden.rlm}`] }, headers: { "If-Match": '"4"' } }); expect(bad.result.status).toBe(422); expect(bad.calls).toHaveLength(0);
  });
  it("sends a rewrite of two different tags and returns the server's mode and count", async () => {
    const same = await call("tag-rewrites", { method: "POST", body: { source: "أ", target: "أ" } }); expect(same.result.status).toBe(422); expect(same.calls).toHaveLength(0);
    const rewrite = { id: randomUUID(), source: "مياة", target: "مياه", mode: "merge", materials_updated: 4, created_at: "2026-11-03T09:05:00Z", created_by: me.user_id, canary: "x" };
    const { result } = await call("tag-rewrites", { method: "POST", body: { source: "مياة", target: "مياه" }, upstream: () => Response.json(rewrite, { status: 201 }) });
    expect(result.status).toBe(201); expect(await result.json()).toEqual({ ...rewrite, canary: undefined });
  });
  it("keeps platform identity and tag usage to the system administrator, and money reports to finance and the administrator", async () => {
    expect((await call("platform-settings", { user: finance })).result.status).toBe(403);
    expect((await call("tags", { user: finance })).result.status).toBe(403);
    const noMonth = await call("contributor-earnings", { user: finance }); expect(noMonth.result.status).toBe(400); expect(noMonth.calls).toHaveLength(0);
    expect((await call("contributor-earnings?month=2026-11", { user: supervisor })).result.status).toBe(403);
    const totals = await call("buyer-purchase-totals?year=2026", { user: finance, upstream: () => Response.json({ year: 2026, items: [{ organization_id: randomUUID(), currency: "USD", paid_orders: 2, paid: usd(500), refunded: usd(0), billing_email: "b@example.test" }], next_cursor: null }) });
    expect(totals.result.status).toBe(200); expect(await totals.result.text()).not.toContain("@");
    const platform = await call("platform-settings", { method: "PUT", body: { platform_name: "أ", app_name: "ب", watermark_text: " ج" }, headers: { "If-Match": '"1"' } }); expect(platform.result.status).toBe(422); expect(platform.calls).toHaveLength(0);
  });
});
