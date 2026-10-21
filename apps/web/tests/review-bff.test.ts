import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { form, material, me, tokens } from "./fixtures";
const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], trustForwardedFor: false };
const key = randomUUID(), item = material(), target = "10000000-0000-4000-8000-000000000002";
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] };
const supervisor: Me = { ...me, roles: [{ name: "supervisor", scopes: [] }] };
async function action(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [];
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method: options.method ?? "POST", headers: { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": key, "If-Match": '"17"', ...options.headers }, ...(options.method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? supervisor);
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}
describe("authenticated review writes", () => {
  it("preserves the same idempotency key, revision and one-track payload upstream", async () => {
    const body = { track: "editorial", to: "acknowledged", reason: "reviewed" };
    const { result, calls } = await action(`materials/${item.id}/transitions`, { body, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json({ ...item, editorial_state: "acknowledged", gps: { lat: 1, lng: 2 }, protected_source: "canary" }); } });
    expect(result.status).toBe(200); expect(calls).toHaveLength(1); expect(calls[0].headers.get("If-Match")).toBe('"17"'); expect(calls[0].headers.get("Idempotency-Key")).toBe(key);
    expect(calls[0].headers.get("Cookie")).toBeNull(); expect(await result.text()).not.toContain("canary");
  });
  it("returns a safe 412 without retrying or replacing the submitted revision", async () => {
    const { result, calls } = await action(`materials/${item.id}/transitions`, { body: { track: "editorial", to: "acknowledged", reason: "reviewed" }, upstream: () => Response.json({ message: "secret canary" }, { status: 412 }) });
    expect(result.status).toBe(412); expect(await result.json()).toEqual({ code: "precondition_failed" }); expect(calls).toHaveLength(1);
  });
  it.each(["PUT", "DELETE"])("requires the same CSRF checks for %s", async method => {
    const { result, calls } = await action(`users/${target}/permissions/protected_source:read`, { method, user: admin, body: { reason: "reviewed" }, headers: { Origin: "https://other.example.test" } });
    expect(result.status).toBe(403); expect(calls).toHaveLength(0);
  });
  it("requires a revision and UUID idempotency key before material mutation", async () => {
    const body = { track: "editorial", to: "acknowledged", reason: "reviewed" };
    for (const [headers, status] of [[{ "If-Match": "" }, 428], [{ "Idempotency-Key": "bad" }, 400]] as const) {
      const { result, calls } = await action(`materials/${item.id}/transitions`, { body, headers }); expect(result.status).toBe(status); expect(calls).toHaveLength(0);
    }
  });
  it.each(["sensitive_location:read", "protected_source:read"])("grants or revokes only the requested permission %s", async permission => {
    for (const method of ["PUT", "DELETE"]) {
      const { result, calls } = await action(`users/${target}/permissions/${permission}`, { method, user: admin, body: method === "PUT" ? { reason: "approved" } : {} });
      expect(result.status).toBe(204); expect(calls).toHaveLength(1); expect(decodeURI(calls[0].url).replace("%3A", ":")).toBe(`${config.api}/users/${target}/permissions/${permission}`); expect(calls[0].headers.get("Idempotency-Key")).toBe(key);
    }
  });
  it("does not turn reading permissions into administration and rechecks the current roles", async () => {
    const { result, calls } = await action(`users/${target}/status`, { method: "PUT", user: { ...me, permissions: ["sensitive_location:read", "protected_source:read"] }, body: { status: "suspended" } });
    expect(result.status).toBe(403); expect(calls).toHaveLength(0);
  });
  it("sends only the contract status, rejects free text and self-suspension", async () => {
    const { result } = await action(`users/${target}/status`, { method: "PUT", user: admin, body: { status: "suspended" }, upstream: async r => { expect(await r.json()).toEqual({ status: "suspended" }); return new Response(null, { status: 204 }); } }); expect(result.status).toBe(204);
    for (const [id, body, status] of [[me.user_id, { status: "suspended" }, 403], [target, { status: "suspended", reason: "canary" }, 422], [target, { status: "active", reason_code: "custom" }, 422]] as const) {
      const { result, calls } = await action(`users/${id}/status`, { method: "PUT", user: admin, body }); expect(result.status).toBe(status); expect(calls).toHaveLength(0);
    }
  });
  it("rejects invalid shares before contacting the write endpoint", async () => {
    const { result, calls } = await action(`materials/${item.id}/contributors`, { method: "PUT", user: admin, body: { contributors: [{ user_id: target, role: "reporter", share_percent: 99 }] } });
    expect(result.status).toBe(422); expect(calls).toHaveLength(0);
  });
  it("version-checks reservation and forwards release without an invented revision requirement", async () => {
    const { result, calls } = await action(`materials/${item.id}/reservation`, { user: { ...me, roles: [{ name: "producer", scopes: [] }] }, upstream: () => Response.json({ material_id: item.id, reserved_by: me.user_id, reserved_at: "2026-10-20T12:00:00Z", releases_at: "2026-10-20T12:30:00Z", extra: "canary" }) });
    expect(result.status).toBe(200); expect(calls[0].headers.get("If-Match")).toBe('"17"'); expect(await result.text()).not.toContain("canary");
    const release = await action(`materials/${item.id}/reservation`, { method: "DELETE", user: admin }); expect(release.result.status).toBe(204); expect(release.calls[0].headers.has("If-Match")).toBe(false);
  });
  it("marks and acknowledges notifications without forwarding arbitrary text", async () => {
    for (const kind of ["read", "ack"]) {
      expect((await action(`notifications/${target}/${kind}`)).result.status).toBe(204);
      expect((await action(`notifications/${target}/${kind}`, { body: { title: "canary" } })).result.status).toBe(422);
    }
  });
  it("exposes a material row ETag and not a content-version substitute", async () => {
    const { result } = await action(`materials/${item.id}`, { method: "GET", upstream: r => r.url.includes("/forms/") ? Response.json(form) : Response.json({ ...item, version: 3, row_version: 17 }) });
    expect(result.headers.get("ETag")).toBe('"17"');
  });
  it("paginates notifications while stripping raw titles and validating filters", async () => {
    const { result } = await action("notifications?cursor=next&unread_only=true&limit=20", { method: "GET", upstream: r => { expect(r.url).toContain("cursor=next"); return Response.json({ items: [{ id: target, type: "canary", title: "canary", material_id: item.id, priority: "normal", state: "sent", created_at: item.created_at }], next_cursor: "after", unread_count: 3 }); } });
    const data = await result.json(); expect(data.next_cursor).toBe("after"); expect(data.items).toHaveLength(1); expect(JSON.stringify(data)).not.toContain("canary");
    for (const query of ["limit=101", "limit=1&limit=2", "unread_only=yes", "gps=canary"]) expect((await action(`notifications?${query}`, { method: "GET" })).result.status).toBe(400);
  });
});
