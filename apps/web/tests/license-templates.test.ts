import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { emptyTemplate, templateInput, type TemplateInput } from "../src/lib/license-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const rights: Me = { ...me, roles: [{ name: "rights_officer", scopes: [] }] }, finance: Me = { ...me, roles: [{ name: "finance", scopes: [] }] }, supervisor: Me = { ...me, roles: [{ name: "supervisor", scopes: [] }] };
const id = "81000000-0000-4000-8000-000000000001";
const template: TemplateInput = { ...emptyTemplate(), name: { ar: "تحريري لاستخدام واحد", en: "Editorial single use" }, terms: { ar: "شروط", en: "Terms" }, attribution: { ar: "فلسطين بوست", en: "Palestine Post" }, base_price: { amount_minor: 15000, currency: "USD" } };
const stored = { ...template, id, version: 2, created_at: "2026-10-21T10:00:00Z", created_by: me.user_id };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => { if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? rights); calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("license template input", () => {
  it("accepts a complete template and enforces the contract's cross-field rules", () => {
    expect(templateInput(template as unknown as Record<string, unknown>)).toEqual(template);
    expect(templateInput({ ...template, type: "exclusive_temporary", term_days: 30, exclusivity_hours: 48 })).not.toBeNull();
    expect(templateInput({ ...template, territory: { kind: "countries", countries: ["PS", "JO"] } })).not.toBeNull();
    const bad: Record<string, unknown>[] = [
      { name: { ar: "اسم", en: " " } }, { terms: { ar: "x" } }, { usage_media: [] }, { deliverables: ["transcript"] }, { prohibitions: ["resale"] },
      { type: "editorial_term", term_days: null }, { type: "exclusive_temporary", term_days: 30, exclusivity_hours: null }, { exclusivity_hours: 48 },
      { type: "exclusive_temporary", term_days: 30, exclusivity_hours: 200 }, { term_days: 0 }, { territory: { kind: "countries", countries: [] } },
      { territory: { kind: "countries", countries: ["ps"] } }, { territory: { kind: "worldwide", countries: ["PS"] } }, { base_price: { amount_minor: -1, currency: "USD" } },
      { base_price: { amount_minor: 1, currency: "EUR" } }, { type: "subscription" }, { extra: true },
    ];
    for (const patch of bad) expect(templateInput({ ...template, ...patch }), JSON.stringify(patch)).toBeNull();
  });
});

describe("license template BFF", () => {
  it("lists for finance read-only and refuses roles outside the contract", async () => {
    const { result, calls } = await call("license-templates?include_disabled=true", { method: "GET", user: finance, upstream: () => Response.json({ items: [{ ...stored, internal: "canary" }] }) });
    expect(result.status).toBe(200); expect(new URL(calls[0].url).searchParams.get("include_disabled")).toBe("true"); expect(await result.text()).not.toContain("canary");
    expect((await call("license-templates", { method: "GET", user: supervisor })).result.status).toBe(403);
    expect((await call("license-templates?other=1", { method: "GET" })).result.status).toBe(400);
    const write = await call("license-templates", { user: finance, body: template }); expect(write.result.status).toBe(403); expect(write.calls).toHaveLength(0);
  });
  it("reads a template with its version as ETag", async () => {
    const { result } = await call(`license-templates/${id}`, { method: "GET", upstream: () => Response.json(stored) });
    expect(result.headers.get("ETag")).toBe('"2"'); expect(await result.json()).toEqual(stored);
  });
  it("creates with the caller's idempotency key and replaces with If-Match", async () => {
    const key = randomUUID();
    const created = await call("license-templates", { body: template, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual(template); return Response.json({ ...stored, version: 1 }, { status: 201 }); } });
    expect(created.result.status).toBe(201); expect(created.calls[0].headers.get("Idempotency-Key")).toBe(key); expect(created.result.headers.get("ETag")).toBe('"1"');
    const replaced = await call(`license-templates/${id}`, { method: "PUT", body: template, headers: { "If-Match": '"2"' }, upstream: () => Response.json({ ...stored, version: 3 }) });
    expect(replaced.result.status).toBe(200); expect(replaced.calls[0].headers.get("If-Match")).toBe('"2"'); expect(replaced.result.headers.get("ETag")).toBe('"3"');
    const missing = await call(`license-templates/${id}`, { method: "PUT", body: template }); expect(missing.result.status).toBe(428); expect(missing.calls).toHaveLength(0);
    const stale = await call(`license-templates/${id}`, { method: "PUT", body: template, headers: { "If-Match": '"1"' }, upstream: () => Response.json({ message: "canary" }, { status: 412 }) });
    expect(stale.result.status).toBe(412); expect(await stale.result.text()).not.toContain("canary");
  });
  it("rejects an invalid template before the API", async () => {
    const { result, calls } = await call("license-templates", { body: { ...template, prohibitions: [] } });
    expect(result.status).toBe(422); expect(calls).toHaveLength(0);
  });
});
