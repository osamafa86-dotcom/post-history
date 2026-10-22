import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { form, material, me, tokens } from "./fixtures";
import { identityReasons, permissions } from "../src/lib/admin-policy";
const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
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
  it.each(["sensitive_location:read", "protected_source:read", "reporter_identity:read"])("grants or revokes only the requested permission %s", async permission => {
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

const setting = { access: "separate", updated_at: "2026-10-21T10:00:00Z", updated_by: null };
describe("reporter identity setting and permission audit history", () => {
  it.each(identityReasons)("sends the coded reason %s and preserves the key without forwarding extra response fields", async reason_code => {
    const body = { access: "protected_source", reason_code };
    const { result, calls } = await action("admin/settings/reporter-identity", { method: "PUT", user: admin, body, upstream: async r => {
      expect(await r.json()).toEqual(body); return Response.json({ ...setting, access: "protected_source", updated_by: me.user_id, legal_name: "never-display-canary" });
    } });
    expect(result.status).toBe(200); expect(calls).toHaveLength(1); expect(calls[0].headers.get("Idempotency-Key")).toBe(key);
    expect(await result.json()).toEqual({ ...setting, access: "protected_source", updated_by: me.user_id });
    expect(result.headers.get("Cache-Control")).toContain("no-store");
  });
  it("requires a coded reason and closed keys before any setting write", async () => {
    for (const body of [{ access: "separate" }, { access: "all", reason_code: "policy_change" }, { access: "separate", reason_code: "free text canary" }, { access: "separate", reason_code: "policy_change", reason: "canary" }]) {
      const { result, calls } = await action("admin/settings/reporter-identity", { method: "PUT", user: admin, body });
      expect(result.status).toBe(422); expect(calls).toHaveLength(0);
    }
    const { result, calls } = await action("admin/settings/reporter-identity", { method: "PUT", user: admin, body: { access: "separate", reason_code: "policy_change" }, headers: { "Idempotency-Key": "" } });
    expect(result.status).toBe(400); expect(calls).toHaveLength(0);
  });
  it("enforces origin checks and does not accept alternate methods for the setting", async () => {
    expect((await action("admin/settings/reporter-identity", { method: "PUT", user: admin, headers: { Origin: "https://other.example.test" } })).result.status).toBe(403);
    for (const method of ["POST", "DELETE"]) expect((await action("admin/settings/reporter-identity", { method, user: admin })).result.status).toBe(405);
  });
  it("rechecks administrator roles for both reads and writes even with all reading permissions", async () => {
    for (const [path, method] of [["admin/settings/reporter-identity", "GET"], ["admin/settings/reporter-identity", "PUT"], [`users/${target}/permissions/history`, "GET"], [`users/${target}/permissions/reporter_identity:read`, "PUT"]]) {
      const { result, calls } = await action(path, { method, user: { ...me, roles: [], permissions }, body: { access: "separate", reason_code: "policy_change" } });
      expect(result.status).toBe(403); expect(calls).toHaveLength(0);
    }
  });
  it("reads only the setting metadata and fails closed on an unknown setting value", async () => {
    const { result } = await action("admin/settings/reporter-identity", { method: "GET", user: admin, upstream: () => Response.json({ ...setting, reporter_legal_name: "never-display-canary" }) });
    expect(await result.json()).toEqual(setting);
    const invalid = await action("admin/settings/reporter-identity", { method: "GET", user: admin, upstream: () => Response.json({ ...setting, access: "never-display-canary" }) });
    expect(invalid.result.status).toBe(503); expect(await invalid.result.text()).not.toContain("canary");
    expect((await action("admin/settings/reporter-identity?extra=x", { method: "GET", user: admin })).result.status).toBe(400);
  });
  it("returns a paginated safe audit projection with global setting events and no free-text reasons", async () => {
    const occurred_at = setting.updated_at;
    const { result, calls } = await action(`users/${target}/permissions/history?limit=20&cursor=next`, { method: "GET", user: admin, upstream: r => {
      expect(r.url).toContain("limit=20"); expect(r.url).toContain("cursor=next");
      return Response.json({ items: [
        { id: "4", kind: "setting_changed", actor_id: me.user_id, occurred_at, setting: "reporter_legal_name_access", value: "protected_source", reason_code: "policy_change", legal_name: "never-display-canary" },
        { id: "3", kind: "permission_granted", actor_id: me.user_id, occurred_at, permission: "reporter_identity:read", reason: "never-display-canary", reason_code: "never-display-canary" },
        { id: "2", kind: "permission_revoked", actor_id: "never-display-canary", occurred_at, permission: "protected_source:read", reason_code: null },
        { id: "1", kind: "setting_changed", actor_id: null, occurred_at, setting: "reporter_legal_name_access", value: "separate", reason_code: "never-display-canary" },
        { id: "0", kind: "unknown", actor_id: null, occurred_at, reason_code: null },
      ], next_cursor: "after", gps: "never-display-canary" });
    } });
    expect(result.status).toBe(200); expect(calls).toHaveLength(1); const data = await result.json();
    expect(data.next_cursor).toBe("after"); expect(data.items).toHaveLength(4); expect(data.items[0].reason_code).toBe("policy_change"); expect(data.items[1].reason_code).toBeNull(); expect(data.items[2].actor_id).toBeNull(); expect(data.items[3].reason_code).toBeNull();
    expect(JSON.stringify(data)).not.toContain("never-display-canary"); expect(result.headers.get("Cache-Control")).toContain("no-store");
  });
  it("rejects invalid audit pagination and arbitrary query keys before upstream access", async () => {
    for (const query of ["limit=0", "limit=101", "limit=abc", "limit=1&limit=2", "cursor=a&cursor=b", "gps=canary", `cursor=${"x".repeat(2049)}`]) {
      const { result, calls } = await action(`users/${target}/permissions/history?${query}`, { method: "GET", user: admin });
      expect(result.status).toBe(400); expect(calls).toHaveLength(0);
    }
  });
  it("returns safe unavailable history and write errors without fabricating records or retrying", async () => {
    const read = await action(`users/${target}/permissions/history`, { method: "GET", user: admin, upstream: () => Response.json({ message: "never-display-canary" }, { status: 404 }) });
    expect(read.result.status).toBe(404); expect(await read.result.text()).not.toContain("canary");
    const write = await action("admin/settings/reporter-identity", { method: "PUT", user: admin, body: { access: "separate", reason_code: "policy_change" }, upstream: () => Response.json({ message: "never-display-canary" }, { status: 503 }) });
    expect(write.result.status).toBe(503); expect(write.calls).toHaveLength(1); expect(await write.result.text()).not.toContain("canary");
  });
  it("enforces contract reason boundaries including supplementary Unicode", async () => {
    for (const [path, body, expected, upstream] of [
      [`users/${target}/permissions/reporter_identity:read`, { reason: "a".repeat(500) }, 204, () => new Response(null, { status: 204 })],
      [`users/${target}/permissions/reporter_identity:read`, { reason: "a".repeat(501) }, 422, () => new Response(null, { status: 204 })],
      [`materials/${item.id}/transitions`, { track: "editorial", to: "acknowledged", reason: "a".repeat(2000) }, 200, () => Response.json(item)],
      [`materials/${item.id}/transitions`, { track: "editorial", to: "acknowledged", reason: "a".repeat(2001) }, 422, () => Response.json(item)],
      [`users/${target}/permissions/reporter_identity:read`, { reason: "😀".repeat(500) }, 204, () => new Response(null, { status: 204 })],
    ] as const) {
      const { result, calls } = await action(path, { method: path.startsWith("materials") ? "POST" : "PUT", user: admin, body, upstream });
      expect(result.status).toBe(expected); expect(calls).toHaveLength(expected === 422 ? 0 : 1);
    }
  });
});

describe("supervisor notes for the reporter", () => {
  const reporter: Me = { ...me, roles: [{ name: "reporter", scopes: [] }] };
  const history = { items: [
    { id: "t1", track: "editorial", from: "reviewing", to: "needs_changes", reason: "أعد التصوير\u0007 من زاوية أخرى", note_timecode_ms: 42000, actor_id: target, occurred_at: "2026-10-21T10:00:00Z" },
    { id: "t2", track: "editorial", from: "inbox", to: "acknowledged", reason: "internal canary", actor_id: target, occurred_at: "2026-10-21T09:00:00Z" },
  ] };
  const upstream = (owner: string) => (r: Request) => r.url.endsWith("/transitions") ? Response.json(history) : Response.json({ ...item, reporter_id: owner });
  it("gives the owner the change request and its timecode, and nothing else", async () => {
    const { result } = await action(`materials/${item.id}/transitions`, { method: "GET", user: reporter, upstream: upstream(me.user_id) });
    const { items } = await result.json();
    expect(items[0]).toMatchObject({ reason: "أعد التصوير من زاوية أخرى", note_timecode_ms: 42000 });
    expect(items[1].reason).toBe(""); expect(JSON.stringify(items)).not.toContain("canary");
  });
  it.each([["another reporter's material", reporter, target], ["a supervisor", supervisor, me.user_id]] as const)("hides every reason from %s", async (_, user, owner) => {
    const { result } = await action(`materials/${item.id}/transitions`, { method: "GET", user, upstream: upstream(owner) });
    expect((await result.json()).items.map((i: { reason: string }) => i.reason)).toEqual(["", ""]);
  });
});
