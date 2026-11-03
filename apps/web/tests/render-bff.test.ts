import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { material, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: ["https://media.example.test"], tusOrigins: [], trustForwardedFor: false };
const key = randomUUID(), item = material(2), fileId = "70000000-0000-4000-8000-000000000001";
const producer: Me = { ...me, roles: [{ name: "producer", scopes: [] }] }, admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] };
const row = { id: "60000000-0000-4000-8000-000000000001", material_id: item.id, material_version: 1, source_file_id: "50000000-0000-4000-8000-000000000002", template: "circulated", aspect: "vertical", title_lines: ["عنوان تجريبي"], show_location: false, location_text: null, label: "none", state: "ready", file_id: fileId, failure_reason: null, requested_by: me.user_id, requested_at: "2026-11-03T14:50:00Z", started_at: "2026-11-03T14:51:00Z", completed_at: "2026-11-03T14:52:00Z" };
const body = { template: "circulated", aspect: "vertical", title_lines: ["عنوان تجريبي"], show_location: true, label: "circulated_footage" };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "GET";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": key }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? producer);
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("circulated render BFF (ADR 0091)", () => {
  it("lists renders through a whitelist for request roles only, and passes the feature-off 404", async () => {
    const { result } = await call(`materials/${item.id}/renders`, { upstream: () => Response.json({ items: [{ ...row, debug: "canary" }, { ...row, state: "paused" }] }) });
    expect(result.status).toBe(200); const text = await result.text(); expect(text).not.toContain("canary"); expect(JSON.parse(text).items).toHaveLength(1);
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    // العلم المطفأ حالة لا خطأ: 204 بلا جسم (لا «فشل تحميل مورد» في وحدة التحكم)، والواجهة تخفي البطاقة.
    const off = await call(`materials/${item.id}/renders`, { upstream: () => Response.json({ code: "not_found" }, { status: 404 }) }); expect(off.result.status).toBe(204); expect(await off.result.text()).toBe("");
    const denied = await call(`materials/${item.id}/renders`, { user: admin }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
  });
  it("forwards the browser key with a rebuilt body and never a location text", async () => {
    const { result, calls } = await call(`materials/${item.id}/renders`, { method: "POST", body, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json({ ...row, state: "requested", file_id: null, completed_at: null, started_at: null }, { status: 202 }); } });
    expect(result.status).toBe(202); expect(calls).toHaveLength(1); expect(calls[0].headers.get("Idempotency-Key")).toBe(key);
    for (const bad of [{ ...body, location_text: "مدينة" }, { ...body, label: null }, { ...body, title_lines: ["x".repeat(23)] }]) {
      const rejected = await call(`materials/${item.id}/renders`, { method: "POST", body: bad }); expect(rejected.result.status).toBe(422); expect(rejected.calls).toHaveLength(0);
    }
  });
  it("passes render error codes with machine details only", async () => {
    const refused = await call(`materials/${item.id}/renders`, { method: "POST", body, upstream: () => Response.json({ code: "render_not_allowed", message: "secret canary", details: { failed: ["source", "canary"], max_source_duration_ms: 300000 } }, { status: 409 }) });
    expect(refused.result.status).toBe(409); expect(await refused.result.json()).toEqual({ code: "render_not_allowed", details: { failed: ["source"], max_source_duration_ms: 300000 } });
    for (const [status, code] of [[409, "render_limit_reached"], [422, "render_location_unusable"]] as const) {
      const { result } = await call(`materials/${item.id}/renders`, { method: "POST", body, upstream: () => Response.json({ code, message: "secret canary" }, { status }) });
      expect(result.status).toBe(status); expect(await result.json()).toEqual({ code });
    }
    const other = await call(`materials/${item.id}/renders`, { method: "POST", body, upstream: () => Response.json({ code: "conflict", details: { canary: 1 } }, { status: 409 }) });
    expect(await other.result.json()).toEqual({ code: "request_failed" });
  });
  it("issues a download link only for a ready copy of this material, from a configured origin", async () => {
    const expires = new Date(Date.now() + 300000).toISOString();
    const upstream = (link: string, status = 200) => (r: Request) => r.url.includes("/renders") ? Response.json({ items: [row] }) : status === 200 ? Response.json({ url: link, expires_at: expires }) : Response.json({ code: "render_not_allowed", details: { failed: ["rights_state"] } }, { status });
    const ok = await call(`materials/${item.id}/files/${fileId}/download-url`, { upstream: upstream("https://media.example.test/derived/x?sig=1") });
    expect(ok.result.status).toBe(200); expect(await ok.result.json()).toEqual({ url: "https://media.example.test/derived/x?sig=1", expires_at: expires });
    const other = await call(`materials/${item.id}/files/${randomUUID()}/download-url`, { upstream: upstream("https://media.example.test/derived/x") });
    expect(other.result.status).toBe(404); expect(other.calls.every(r => r.url.includes("/renders"))).toBe(true);
    const foreign = await call(`materials/${item.id}/files/${fileId}/download-url`, { upstream: upstream("https://elsewhere.example.test/x") }); expect(foreign.result.status).toBe(503);
    const fallen = await call(`materials/${item.id}/files/${fileId}/download-url`, { upstream: upstream("", 409) });
    expect(fallen.result.status).toBe(409); expect(await fallen.result.json()).toEqual({ code: "render_not_allowed", details: { failed: ["rights_state"] } });
  });
});
