import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { allowedDownload } from "../src/lib/issued-licenses";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: ["https://storage.example.test"], tusOrigins: [], trustForwardedFor: false };
const id = "93000000-0000-4000-8000-000000000001", org = "90000000-0000-4000-8000-000000000001";
const buyer: Me = { ...me, organization_id: org, roles: [{ name: "buyer_member", scopes: [] }] }, rights: Me = { ...me, roles: [{ name: "rights_officer", scopes: [] }] }, supervisor: Me = { ...me, roles: [{ name: "supervisor", scopes: [] }] };
const terms = { type: "editorial_single", name: { ar: "تحريري", en: "Editorial" }, terms: { ar: "شروط", en: "Terms" }, usage_media: ["tv"], territory: { kind: "worldwide" }, term_days: null, exclusivity_hours: null, deliverables: ["original"], attribution: { ar: "ف", en: "P" }, prohibitions: ["ai_training"] };
const license = { id, license_number: "PH-2026-7K3M9Q2XRT", order_id: randomUUID(), order_item_id: randomUUID(), organization_id: org, listing_id: randomUUID(), material_version: 1, title: { ar: "لقطات", en: "Footage" }, license_template_id: randomUUID(), license_version: 1, terms, price: { amount_minor: 15000, currency: "USD" }, status: "active", revoked_reason: null, valid_from: "2026-10-26T10:00:00Z", valid_until: null, exclusive_until: null, issued_at: "2026-10-26T10:00:00Z", delivery_ready: true };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID() }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (r: Request) => { if (r.url.endsWith("/auth/me")) return Response.json(options.user ?? buyer); calls.push(r); return options.upstream ? options.upstream(r) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("issued licenses BFF", () => {
  it("lists and reads licenses for the contract roles with safe fields", async () => {
    const list = await call("licenses?status=active", { method: "GET", user: rights, upstream: () => Response.json({ items: [{ ...license, internal: "canary" }], next_cursor: null }) });
    expect(list.result.status).toBe(200); expect(await list.result.text()).not.toContain("canary");
    expect((await call("licenses", { method: "GET", user: supervisor })).result.status).toBe(403);
    expect((await call("licenses?status=void", { method: "GET" })).result.status).toBe(400);
    const one = await call(`licenses/${id}`, { method: "GET", upstream: () => Response.json(license) }); expect((await one.result.json()).license_number).toBe(license.license_number);
  });
  it("hands a counted download link to buyers only, within the storage origins", async () => {
    const ok = await call(`licenses/${id}/download-url`, { upstream: () => Response.json({ url: "https://storage.example.test/d/x?sig=1", expires_at: "2026-10-27T10:00:00Z", downloads_remaining: 2, extra: "canary" }) });
    expect(ok.result.status).toBe(200); expect(ok.result.headers.get("Cache-Control")).toContain("no-store"); expect(await ok.result.json()).toEqual({ url: "https://storage.example.test/d/x?sig=1", expires_at: "2026-10-27T10:00:00Z", downloads_remaining: 2 });
    const evil = await call(`licenses/${id}/download-url`, { upstream: () => Response.json({ url: "https://evil.example.test/x", expires_at: "2026-10-27T10:00:00Z", downloads_remaining: 2 }) });
    expect(evil.result.status).toBe(502); expect(await evil.result.text()).not.toContain("evil");
    const denied = await call(`licenses/${id}/download-url`, { user: rights }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
    const limit = await call(`licenses/${id}/download-url`, { upstream: () => Response.json({ code: "download_limit_reached" }, { status: 409 }) }); expect(limit.result.status).toBe(409);
    expect(allowedDownload("https://u:p@storage.example.test/x", config.mediaOrigins)).toBe(false);
  });
});

it("keeps only contract delivery specifications, size and frozen terms for the buyer", async () => {
  const raw = { ...license, work_name: "never-display-canary", delivery_size_bytes: 1048576, delivery_contents: [{ deliverable: "produced", mime_type: "video/mp4", count: 1, duration_ms: 65000, width: 1920, height: 1080, sha256: "never-display-canary", file_id: id, storage_key: "never-display-canary" }], terms: { ...terms, actor_name: "never-display-canary" } };
  const { result } = await call(`licenses/${id}`, { method: "GET", upstream: () => Response.json(raw) });
  const safe = await result.json(); expect(safe.delivery_size_bytes).toBe(1048576);
  expect(safe.delivery_contents).toEqual([{ deliverable: "produced", mime_type: "video/mp4", count: 1, duration_ms: 65000, width: 1920, height: 1080 }]);
  expect(JSON.stringify(safe)).not.toMatch(/canary|actor_name|work_name|sha256|file_id|storage_key/);
  const noCount = Object.fromEntries(Object.entries(raw.delivery_contents[0]).filter(([key]) => key !== "count"));
  const fallback = await call(`licenses/${id}`, { method: "GET", upstream: () => Response.json({ ...raw, delivery_contents: [noCount] }) });
  expect((await fallback.result.json()).delivery_contents[0].count).toBe(1);
});
