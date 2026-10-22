import { readFileSync, readdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { handle } from "../src/server/handler";
import { fieldTypes, formBodyLimit, newField, nextForm, validForm } from "../src/lib/form-admin";
import type { Form, Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { form, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, chief: Me = { ...me, roles: [{ name: "editor_in_chief", scopes: [] }] };
async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "GET";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), "If-Match": '"1"', ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? nextForm(form, 1)) }) });
  const fetch = (async (input: Request) => { if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(input); return options.upstream ? options.upstream(input) : Response.json({}); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("form publishing validation", () => {
  it("uses all canonical schema examples and exactly its ten field types", () => {
    const root = new URL("../../../contracts/examples/upload-form/", import.meta.url);
    for (const category of ["valid", "invalid"]) for (const name of readdirSync(new URL(`${category}/`, root))) {
      const value = JSON.parse(readFileSync(new URL(`${category}/${name}`, root), "utf8"));
      expect(validForm(value), `${category}/${name}`).toBe(category === "valid");
    }
    const schema = JSON.parse(readFileSync(new URL("../../../contracts/schemas/upload-form.json", import.meta.url), "utf8"));
    expect(fieldTypes).toEqual(schema.$defs.field.properties.type.enum); expect(fieldTypes).toHaveLength(10);
  });
  it("clones immutable snapshots and removes server publication metadata", () => {
    const original = { ...structuredClone(form), published_by: me.user_id, published_at: "2026-10-20T12:00:00Z" };
    const draft = nextForm(original, 7); draft.fields[0].label.ar = "جديد"; draft.fields.reverse();
    expect(original.fields).toEqual(form.fields); expect(draft.version).toBe(8);
    expect(draft).not.toHaveProperty("published_by"); expect(draft).not.toHaveProperty("published_at");
    expect(nextForm(null, 0)).toEqual({ version: 1, fields: [] });
  });
  it("rejects sensitive fields, unknown data, duplicate keys and dangling/self conditions", () => {
    expect(validForm(form)).toBe(true);
    for (const fields of [[{ ...form.fields[0], sensitive: true }], [{ ...form.fields[0], type: "location" }], [form.fields[0], form.fields[0]], [{ ...form.fields[0], condition: { field: "absent", equals: true } }], [{ ...form.fields[0], condition: { field: form.fields[0].key, equals: true } }], [{ ...form.fields[0], extra: "canary" }]]) expect(validForm({ version: 2, fields })).toBe(false);
    for (const type of fieldTypes.filter(t => t !== "location")) {
      const field = newField(type, "example"); field.label = { ar: "مثال", en: "Example" }; field.validation?.options?.forEach(o => { o.label = field.label; });
      expect(validForm({ version: 2, fields: [field] }), type).toBe(true);
    }
  });
});
describe("form administration BFF", () => {
  it("lists only for contract roles and projects publication summaries", async () => {
    const summary = { version: 1, field_count: form.fields.length, published_at: "2026-10-20T12:00:00Z", is_current: true };
    for (const user of [admin, chief]) {
      const { result } = await call("forms", { user, upstream: () => Response.json({ items: [{ ...summary, internal: "canary", published_by: "canary" }] }) });
      expect(result.status).toBe(200); expect(await result.json()).toEqual({ items: [summary] }); expect(result.headers.get("Cache-Control")).toContain("no-store");
    }
    const denied = await call("forms", { user: me }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
  });
  it("publishes with caller idempotency and current version; reads current and unchanged history", async () => {
    const snapshots = new Map<number, Form>([[1, structuredClone(form)]]), key = randomUUID(), draft = nextForm(form, 1); draft.fields[0].searchable = true;
    const upstream = async (r: Request) => {
      const path = new URL(r.url).pathname;
      if (r.method === "POST") { expect(r.headers.get("If-Match")).toBe('"1"'); expect(r.headers.get("Idempotency-Key")).toBe(key); const data = await r.json() as Form; snapshots.set(data.version, data); return Response.json(data, { status: 201 }); }
      return Response.json(snapshots.get(path.endsWith("current") ? 2 : 1));
    };
    expect((await call("forms", { method: "POST", body: draft, headers: { "Idempotency-Key": key }, upstream })).result.status).toBe(201);
    expect(await (await call("forms/current", { upstream })).result.json()).toEqual(draft);
    expect(await (await call("forms/1", { upstream })).result.json()).toEqual(form);
  });
  it("enforces fresh roles, CSRF, closed paths, preconditions and bounded streaming bodies", async () => {
    const rejected = [
      await call("forms", { method: "POST", user: chief }),
      await call("forms", { method: "POST", user: me }),
      await call("forms", { method: "POST", headers: { Origin: "https://evil.example" } }),
      await call("forms", { method: "POST", headers: { "If-Match": "" } }),
      await call("forms", { method: "POST", headers: { "If-Match": '"01"' } }),
      await call("forms", { method: "POST", headers: { "Idempotency-Key": "bad" } }),
      await call("forms", { method: "POST", body: { version: 1, fields: [] } }),
      await call("forms/1", { method: "PUT" }), await call("forms", { method: "DELETE" }),
      await call("forms", { method: "POST", body: { version: 2, fields: [], extra: "x".repeat(formBodyLimit) } }),
    ];
    expect(rejected.map(x => x.result.status)).toEqual([403, 403, 403, 428, 400, 400, 422, 405, 405, 413]);
    rejected.forEach(x => expect(x.calls).toHaveLength(0));
    for (const path of ["forms?other=1", "forms/1?other=1", "forms/current?material_type=report&material_type=interview", "forms/current?other=1"]) expect((await call(path)).result.status).toBe(400);
  });
  it("accepts a full snapshot above the review-action limit and permits the first version", async () => {
    const large = { version: 1, fields: Array.from({ length: 65 }, (_, i) => ({ ...form.fields[0], key: `field_${i}` })) };
    expect(JSON.stringify(large).length).toBeGreaterThan(8192);
    const { result } = await call("forms", { method: "POST", headers: { "If-Match": '"0"' }, body: large, upstream: () => Response.json(large, { status: 201 }) });
    expect(result.status).toBe(201);
  });
  it("preserves conflict status without returning raw API errors", async () => {
    for (const status of [409, 412, 422, 503]) {
      const { result } = await call("forms", { method: "POST", upstream: () => Response.json({ message: "never-display-canary", fields: ["secret"] }, { status }) });
      expect(result.status).toBe(status); expect(await result.text()).not.toMatch(/canary|secret/);
    }
  });
});
