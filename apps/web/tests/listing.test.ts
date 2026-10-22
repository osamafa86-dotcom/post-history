import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { listingInput, type ListingInput } from "../src/lib/listing-policy";
import { MemoryStore } from "./memory-store";
import { material, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const rights: Me = { ...me, roles: [{ name: "rights_officer", scopes: [] }] }, chief: Me = { ...me, roles: [{ name: "editor_in_chief", scopes: [] }] }, supervisor: Me = { ...me, roles: [{ name: "supervisor", scopes: [] }] };
const item = material(), template = "81000000-0000-4000-8000-000000000001";
const input: ListingInput = { title: { ar: "قصف على خان يونس", en: "Strikes on Khan Younis" }, description: { ar: "لقطات", en: "Footage" }, shot_list: [], offers: [{ license_template_id: template, price_override: null }], commercial_allowed: false, state: "draft" };
const stored = { ...input, id: randomUUID(), material_id: item.id, material_version: 1, suspended_reason: null, listed_at: null, created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z", updated_by: me.user_id };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (r: Request) => { if (r.url.endsWith("/auth/me")) return Response.json(options.user ?? rights); calls.push(r); return options.upstream ? options.upstream(r) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path, { config, store, fetch }), calls };
}

describe("listing input", () => {
  it("accepts a complete listing and rejects what the contract forbids", () => {
    expect(listingInput(input as unknown as Record<string, unknown>)).toEqual(input);
    expect(listingInput({ ...input, offers: [{ license_template_id: template, price_override: { amount_minor: 900, currency: "ILS" } }] })).not.toBeNull();
    const bad: Record<string, unknown>[] = [{ offers: [] }, { offers: [{ license_template_id: template }, { license_template_id: template }] }, { offers: Array.from({ length: 11 }, () => ({ license_template_id: randomUUID() })) },
      { offers: [{ license_template_id: "x" }] }, { offers: [{ license_template_id: template, price_override: { amount_minor: 1, currency: "EUR" } }] }, { title: { ar: "عنوان" } }, { description: { ar: " ", en: "x" } },
      { state: "published" }, { shot_list: [{ start_ms: -1, label: { ar: "a", en: "b" } }] }, { material_version: 2 }];
    for (const patch of bad) expect(listingInput({ ...input, ...patch }), JSON.stringify(patch)).toBeNull();
  });
});

describe("listing BFF", () => {
  it("reads the listing for staff with its ETag, passes 404 through and refuses other roles", async () => {
    const { result } = await call(`materials/${item.id}/listing`, { method: "GET", user: chief, upstream: () => Response.json({ ...stored, reporter_id: "canary" }, { headers: { ETag: '"4"' } }) });
    expect(result.headers.get("ETag")).toBe('"4"'); expect(await result.text()).not.toContain("canary");
    expect((await call(`materials/${item.id}/listing`, { method: "GET", upstream: () => Response.json({ code: "not_found" }, { status: 404 }) })).result.status).toBe(404);
    expect((await call(`materials/${item.id}/listing`, { method: "GET", user: supervisor })).result.status).toBe(403);
  });
  it("creates with the idempotency key, replaces with If-Match, and keeps writes to the contract roles", async () => {
    const key = randomUUID();
    const created = await call(`materials/${item.id}/listing`, { body: input, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual(input); return Response.json(stored, { status: 201, headers: { ETag: '"1"' } }); } });
    expect(created.result.status).toBe(201); expect(created.calls[0].headers.get("Idempotency-Key")).toBe(key);
    const replaced = await call(`materials/${item.id}/listing`, { method: "PUT", body: { ...input, state: "listed" }, headers: { "If-Match": '"1"' }, upstream: () => Response.json({ ...stored, state: "listed" }, { headers: { ETag: '"2"' } }) });
    expect(replaced.result.status).toBe(200); expect(replaced.calls[0].headers.get("If-Match")).toBe('"1"'); expect(replaced.result.headers.get("ETag")).toBe('"2"');
    const conflict = await call(`materials/${item.id}/listing`, { body: { ...input, state: "listed" }, upstream: () => Response.json({ code: "rights_not_sellable", message: "canary" }, { status: 409 }) });
    expect(conflict.result.status).toBe(409); expect(await conflict.result.text()).not.toContain("canary");
    for (const user of [chief, supervisor]) { const denied = await call(`materials/${item.id}/listing`, { user, body: input }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0); }
    const invalid = await call(`materials/${item.id}/listing`, { body: { ...input, offers: [] } }); expect(invalid.result.status).toBe(422); expect(invalid.calls).toHaveLength(0);
  });
});

describe("sellable rights", () => {
  it("lets only the rights officer make a material sellable", async () => {
    const body = { track: "rights", to: "sellable", reason: "contract checked" };
    const ok = await call(`materials/${item.id}/transitions`, { body, headers: { "If-Match": '"3"' }, upstream: () => Response.json({ ...item, rights_state: "sellable" }) });
    expect(ok.result.status).toBe(200); expect(ok.calls).toHaveLength(1);
    const denied = await call(`materials/${item.id}/transitions`, { user: chief, body, headers: { "If-Match": '"3"' } });
    expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
  });
});
