import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import { activeTab, matchesSearch, reviewingStates, tabCounts, tabQuery, tabsFor } from "../src/lib/inbox-tabs";
import { materialQuery } from "../src/lib/query";
import type { Material, Me, NewsroomDashboard } from "../src/lib/types";
import { MemoryStore } from "./memory-store";
import { material, me, tokens } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const as = (...roles: string[]): Me => ({ ...me, roles: roles.map(name => ({ name, scopes: [] })) as Me["roles"] });
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

describe("inbox quick tabs follow the work, not one state each", () => {
  it("keeps a received material in «under review» until it is decided, and gives the publisher a final-review tab", () => {
    expect(reviewingStates).toEqual(["acknowledged", "reviewing", "needs_changes"]);
    expect(tabQuery.reviewing).toEqual({ editorial_state: "acknowledged,reviewing,needs_changes" });
    expect(tabQuery.final_review).toEqual({ editorial_state: "final_review" });
    expect(tabsFor(as("supervisor"))).toEqual(["all", "urgent", "inbox", "reviewing", "accepted", "stopped"]);
    expect(tabsFor(as("producer"))).not.toContain("final_review");
    expect(tabsFor(as("editor_in_chief"))).toEqual(["all", "urgent", "inbox", "reviewing", "accepted", "final_review", "stopped"]);
    expect(activeTab({ limit: 50, ...tabQuery.reviewing })).toBe("reviewing");
    expect(activeTab({ limit: 50, cursor: "x", ...tabQuery.final_review })).toBe("final_review");
    for (const m of [ar, en]) { expect(m.inboxTabs.final_review).toBeTruthy(); expect(Object.keys(m.inboxTabs).sort()).toEqual(["accepted", "all", "final_review", "inbox", "label", "reviewing", "stopped", "urgent"]); }
  });
  it("counts each tab from the snapshot by the states it lists", () => {
    const snapshot = { editorial: [{ state: "inbox", count: 6 }, { state: "acknowledged", count: 2 }, { state: "reviewing", count: 3 }, { state: "needs_changes", count: 1 }, { state: "accepted", count: 4 }, { state: "final_review", count: 5 }, { state: "published", count: 7 }], technical: [{ state: "failed", count: 2 }], urgent_open: 9 } as unknown as NewsroomDashboard;
    expect(tabCounts(snapshot)).toEqual({ all: 28, urgent: 9, inbox: 6, reviewing: 6, accepted: 4, final_review: 5, stopped: 2 });
  });
  it("accepts a list of editorial states in the query, each from the contract and once", () => {
    const query = (value: string) => materialQuery(new URLSearchParams({ editorial_state: value }));
    expect(query("acknowledged,reviewing,needs_changes")).toEqual({ editorial_state: "acknowledged,reviewing,needs_changes" });
    expect(query("inbox")).toEqual({ editorial_state: "inbox" });
    for (const bad of ["acknowledged,unknown", "acknowledged,acknowledged", "acknowledged,", ",reviewing", "acknowledged, reviewing"]) expect(() => query(bad), bad).toThrow();
    // بقية الحالات قيمة واحدة كما في العقد
    expect(() => materialQuery(new URLSearchParams({ technical_state: "pending,failed" }))).toThrow();
  });
});

describe("the BFF lists a tab of several states page by page", () => {
  const row = (index: number, state: Material["editorial_state"], created: string): Material => ({ ...material(index), editorial_state: state, created_at: created });
  function setup() {
    const calls: Array<{ state: string | null; cursor: string | null; limit: string | null }> = [];
    const pages: Record<string, Record<string, { items: Material[]; next_cursor: string | null }>> = {
      acknowledged: { "": { items: [row(1, "acknowledged", "2026-10-03T10:00:00Z"), row(2, "acknowledged", "2026-10-01T10:00:00Z")], next_cursor: "ack-2" }, "ack-2": { items: [row(3, "acknowledged", "2026-09-01T10:00:00Z")], next_cursor: null } },
      reviewing: { "": { items: [row(4, "reviewing", "2026-10-02T10:00:00Z")], next_cursor: null } },
      needs_changes: { "": { items: [row(5, "needs_changes", "2026-10-04T10:00:00Z")], next_cursor: "nc-2" }, "nc-2": { items: [row(6, "needs_changes", "2026-08-01T10:00:00Z")], next_cursor: null } },
    };
    const fetch = (async (input: Request) => {
      const url = new URL(input.url);
      if (url.pathname.endsWith("/auth/me")) return Response.json({ ...me, roles: [{ name: "supervisor", scopes: [] }] });
      const state = url.searchParams.get("editorial_state"), cursor = url.searchParams.get("cursor");
      calls.push({ state, cursor, limit: url.searchParams.get("limit") });
      return Response.json(pages[state ?? ""]?.[cursor ?? ""] ?? { items: [], next_cursor: null });
    }) as typeof globalThis.fetch;
    return { calls, fetch };
  }
  const get = async (search: string, fetch: typeof globalThis.fetch, store = new MemoryStore()) => {
    const id = await store.create(tokens());
    return handle(new NextRequest(`${config.origin}/api/bff/materials?${search}`, { headers: { Cookie: `${config.cookieName}=${id}` } }), "materials", { config, store, fetch });
  };

  it("asks the server once per state, merges newest first, and pages each state by its own cursor", async () => {
    const { calls, fetch } = setup();
    const first = await get("limit=50&editorial_state=acknowledged%2Creviewing%2Cneeds_changes", fetch), body = await first.json();
    expect(first.status).toBe(200);
    expect(calls).toEqual([{ state: "acknowledged", cursor: null, limit: "50" }, { state: "reviewing", cursor: null, limit: "50" }, { state: "needs_changes", cursor: null, limit: "50" }]);
    expect(body.items.map((item: Material) => item.editorial_state)).toEqual(["needs_changes", "acknowledged", "reviewing", "acknowledged"]);
    expect(typeof body.next_cursor).toBe("string");
    // الصفحة التالية: الحالتان اللتان بقي فيهما شيء وحدهما، كلٌّ بمؤشّرها
    calls.length = 0;
    const second = await get(`limit=50&editorial_state=acknowledged%2Creviewing%2Cneeds_changes&cursor=${encodeURIComponent(body.next_cursor)}`, fetch), next = await second.json();
    expect(calls).toEqual([{ state: "acknowledged", cursor: "ack-2", limit: "50" }, { state: "needs_changes", cursor: "nc-2", limit: "50" }]);
    expect(next.items.map((item: Material) => item.id)).toEqual([material(3).id, material(6).id]); expect(next.next_cursor).toBeNull();
  });
  it("refuses a cursor that is not its own", async () => {
    const { calls, fetch } = setup();
    for (const cursor of ["ack-2", "m.not-base64!", `m.${Buffer.from(JSON.stringify({ published: "x" })).toString("base64url")}`, `m.${Buffer.from(JSON.stringify({ acknowledged: 7 })).toString("base64url")}`, `m.${Buffer.from("[]").toString("base64url")}`]) {
      const result = await get(`editorial_state=acknowledged%2Creviewing&cursor=${encodeURIComponent(cursor)}`, fetch);
      expect(result.status, cursor).toBe(400);
    }
    expect(calls).toEqual([]);
  });
  it("leaves a single state to the server as before", async () => {
    const { calls, fetch } = setup();
    await get("limit=50&editorial_state=reviewing&cursor=abc", fetch);
    expect(calls).toEqual([{ state: "reviewing", cursor: "abc", limit: "50" }]);
  });
});

describe("search and labels", () => {
  it("finds a number whichever digits it was typed or written in", () => {
    expect(matchesSearch("13", ["عاجل حي ١٣"])).toBe(true);
    expect(matchesSearch("١٣", ["material 13"])).toBe(true);
    expect(matchesSearch("۱۳", ["عاجل حي ١٣"])).toBe(true);
    expect(matchesSearch("14", ["عاجل حي ١٣"])).toBe(false);
    expect(matchesSearch("  ", ["anything"])).toBe(true);
  });
  it("names the board column by what it counts, apart from the inbox tab", () => {
    for (const m of [ar, en]) expect(m.board.columns.incoming).not.toBe(m.inboxTabs.inbox);
  });
  it("leaves room under a wall title for the dots of a final letter", () => {
    const rule = css.split("\n").find(line => line.startsWith(".tile-title "))!;
    expect(rule).toMatch(/padding-block-end:\s*\d+px/);
  });
});
