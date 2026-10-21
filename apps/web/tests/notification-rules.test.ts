import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { emptyRule, ruleInput, type RuleInput } from "../src/lib/notification-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, chief: Me = { ...me, roles: [{ name: "editor_in_chief", scopes: [] }] }, supervisor: Me = { ...me, roles: [{ name: "supervisor", scopes: [] }] };
const id = "80000000-0000-4000-8000-000000000001";
const rule: RuleInput = { ...emptyRule(), name: "عاجل", assignment: true, escalation: [{ level: 1, after_seconds: 600, recipient_roles: ["editor_in_chief"], channels: ["in_app", "email"] }] };
const stored = { ...rule, id, row_version: 3, created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-21T10:00:00Z", created_by: null, updated_by: null };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => { if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path, { config, store, fetch }), calls };
}

describe("notification rule input", () => {
  it("accepts a complete rule and enforces contract rules", () => {
    expect(ruleInput(rule as unknown as Record<string, unknown>)).toEqual(rule);
    const bad: Partial<Record<keyof RuleInput | "extra", unknown>>[] = [
      { recipient_roles: [], recipient_permissions: [] }, { channels: [] }, { assignment: false }, { name: " " }, { scope_kind: "office", scope_id: "" }, { scope_id: "x" },
      { escalation: [{ level: 2, after_seconds: 600, recipient_roles: ["supervisor"], channels: ["in_app"] }] },
      { escalation: [{ level: 1, after_seconds: 600, recipient_roles: ["supervisor"], channels: ["in_app"] }, { level: 2, after_seconds: 600, recipient_roles: ["supervisor"], channels: ["in_app"] }] },
      { digest_interval_minutes: 5 }, { quiet_hours: { start: "25:00", end: "07:00", timezone: "Asia/Gaza" } }, { event_type: "order.paid" }, { extra: 1 },
    ];
    for (const patch of bad) expect(ruleInput({ ...rule, ...patch } as Record<string, unknown>)).toBeNull();
  });
});

describe("notification rules BFF", () => {
  it("lets the editor in chief read with a whitelist and ETag, and refuses other roles", async () => {
    const list = await call("notification-rules", { method: "GET", user: chief, upstream: () => Response.json({ items: [{ ...stored, secret: "canary" }] }) });
    expect(list.result.status).toBe(200); expect(await list.result.text()).not.toContain("canary");
    const one = await call(`notification-rules/${id}`, { method: "GET", user: chief, upstream: () => Response.json(stored) });
    expect(one.result.headers.get("ETag")).toBe('"3"');
    const refused = await call("notification-rules", { method: "GET", user: supervisor });
    expect(refused.result.status).toBe(403); expect(refused.calls).toHaveLength(0);
  });
  it("writes only as system admin, with If-Match on replace and delete", async () => {
    expect((await call("notification-rules", { user: chief, body: rule })).result.status).toBe(403);
    const created = await call("notification-rules", { body: rule, upstream: async r => { expect(await r.json()).toEqual(rule); return Response.json(stored, { status: 201 }); } });
    expect(created.result.status).toBe(201); expect(created.result.headers.get("ETag")).toBe('"3"');
    const missing = await call(`notification-rules/${id}`, { method: "PUT", body: rule });
    expect(missing.result.status).toBe(428); expect(missing.calls).toHaveLength(0);
    const stale = await call(`notification-rules/${id}`, { method: "PUT", body: rule, headers: { "If-Match": '"3"' }, upstream: () => new Response(null, { status: 412 }) });
    expect(stale.result.status).toBe(412); expect(stale.calls[0].headers.get("If-Match")).toBe('"3"');
    const removed = await call(`notification-rules/${id}`, { method: "DELETE", headers: { "If-Match": '"3"' } });
    expect(removed.result.status).toBe(204);
    const invalid = await call("notification-rules", { body: { ...rule, channels: [] } });
    expect(invalid.result.status).toBe(422); expect(invalid.calls).toHaveLength(0);
  });
});
