import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { conflictResolve, nextStates, type InviteConflict } from "../src/lib/invite-conflict-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, finance: Me = { ...me, roles: [{ name: "finance", scopes: [] }] };
const id = randomUUID();
const conflict: InviteConflict = { id, organization_id: randomUUID(), email: "existing@example.test", existing_user_id: randomUUID(), role: "buyer_member", state: "pending", invited_by: randomUUID(), invite_expires_at: "2026-11-02T10:00:00Z", created_at: "2026-10-26T10:00:00Z", resolved_at: null, resolved_by: null };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID() }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (req: Request) => { if (req.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(req); return options.upstream ? options.upstream(req) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls, store, session };
}

describe("invite conflict resolution input", () => {
  it("takes a resolving state and a present six-digit code, nothing else", () => {
    expect(conflictResolve({ state: "dismissed", totp_code: "123456" })).toEqual({ state: "dismissed", totp_code: "123456" });
    for (const body of [{ state: "pending", totp_code: "123456" }, { state: "dismissed" }, { state: "dismissed", totp_code: "12345" }, { state: "dismissed", totp_code: 123456 }, { state: "dismissed", totp_code: "123456", note: "free text" }])
      expect(conflictResolve(body as Record<string, unknown>), JSON.stringify(body)).toBeNull();
  });
  it("offers only the contract's transitions", () => {
    expect([...nextStates("pending")]).toEqual(["suspended", "dismissed"]); expect([...nextStates("suspended")]).toEqual(["dismissed"]); expect(nextStates("dismissed")).toEqual([]);
  });
});

describe("invite conflict BFF", () => {
  it("lists for the system admin only, through the allowlist", async () => {
    const { result, calls } = await call("buyer-invite-conflicts?state=pending", { method: "GET", upstream: () => Response.json({ items: [{ ...conflict, internal: "canary" }], next_cursor: null }) });
    expect(result.status).toBe(200); expect(new URL(calls[0].url).searchParams.get("state")).toBe("pending"); expect(await result.text()).not.toContain("canary");
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    expect((await call("buyer-invite-conflicts", { method: "GET", user: finance })).result.status).toBe(403);
    for (const query of ["state=open", "limit=0", "state=pending&state=dismissed", "other=1"]) expect((await call(`buyer-invite-conflicts?${query}`, { method: "GET" })).result.status).toBe(400);
  });
  it("resolves with the code passed through and never stored, and refuses other roles and free text", async () => {
    let sent: unknown;
    const done = await call(`buyer-invite-conflicts/${id}/resolve`, { body: { state: "suspended", totp_code: "654321" }, upstream: async req => { sent = await req.json(); return Response.json({ ...conflict, state: "suspended" }); } });
    expect(done.result.status).toBe(200); expect(sent).toEqual({ state: "suspended", totp_code: "654321" }); expect(done.calls[0].headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await done.result.text()).not.toContain("654321");
    const denied = await call(`buyer-invite-conflicts/${id}/resolve`, { user: finance, body: { state: "dismissed", totp_code: "123456" } }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
    const free = await call(`buyer-invite-conflicts/${id}/resolve`, { body: { state: "dismissed", totp_code: "123456", reason: "x" } }); expect(free.result.status).toBe(422); expect(free.calls).toHaveLength(0);
    expect((await call(`buyer-invite-conflicts/not-a-uuid/resolve`, { body: { state: "dismissed", totp_code: "123456" } })).calls).toHaveLength(0);
    expect((await call(`buyer-invite-conflicts/${id}/resolve`, { body: { state: "suspended", totp_code: "123456" }, upstream: () => Response.json({ code: "invalid_transition" }, { status: 409 }) })).result.status).toBe(409);
  });
  it("keeps the admin's session when the code is rejected (401 totp_required becomes 422)", async () => {
    const rejected = await call(`buyer-invite-conflicts/${id}/resolve`, { body: { state: "dismissed", totp_code: "000000" }, upstream: () => Response.json({ code: "totp_required" }, { status: 401 }) });
    expect(rejected.result.status).toBe(422); expect(await rejected.result.json()).toEqual({ code: "totp_required" });
    expect(await rejected.store.read(rejected.session)).not.toBeNull();
    const revoked = await call(`buyer-invite-conflicts/${id}/resolve`, { body: { state: "dismissed", totp_code: "000000" }, upstream: () => Response.json({ code: "unauthorized" }, { status: 401 }) });
    expect(revoked.result.status).toBe(401); expect(await revoked.store.read(revoked.session)).toBeNull();
  });
});
