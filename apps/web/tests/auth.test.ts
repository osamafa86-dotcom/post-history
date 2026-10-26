import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { handle } from "../src/server/handler";
import { withSession, requireOk } from "../src/server/auth";
import { seal, unseal } from "../src/server/sessions";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { material, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const response = (body: unknown, status = 200) => Response.json(body, { status });
function request(path: string, id?: string, body?: unknown, origin = config.origin) {
  return new NextRequest(`${config.origin}/api/bff/${path}`, { method: body === undefined ? "GET" : "POST", headers: { Cookie: id ? `${config.cookieName}=${id}` : "", Origin: origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function transport(fn: (request: Request) => Response | Promise<Response>): typeof fetch { return (async input => fn(input as Request)) as typeof fetch; }

describe("BFF session boundary", () => {
  it("forwards the client address to login and refresh only when the edge is trusted", async () => {
    const trusted = { ...config, trustForwardedFor: true };
    const seen: Array<[string, string | null]> = [];
    const fetch = transport(r => { seen.push([r.url.split("/v1")[1]!, r.headers.get("X-Client-Address")]); return response(r.url.endsWith("/auth/me") ? me : tokens()); });
    const login = (cfg: WebConfig, forwarded?: string) => {
      const req = request("auth/login", undefined, { email: me.email, password: "synthetic-password" });
      if (forwarded) req.headers.set("X-Forwarded-For", forwarded);
      return handle(req, "auth/login", { config: cfg, store: new MemoryStore(), fetch });
    };
    await login(trusted, "198.51.100.7, 203.0.113.9");
    await login(trusted, "not-an-address");
    await login(config, "203.0.113.9");
    const store = new MemoryStore(), id = await store.create({ ...tokens(), expires_at: new Date(0).toISOString() });
    const refreshing = request("auth/me", id); refreshing.headers.set("X-Forwarded-For", "203.0.113.10");
    await handle(refreshing, "auth/me", { config: trusted, store, fetch });
    expect(seen).toEqual([
      ["/auth/login", "203.0.113.9"],
      ["/auth/login", null],
      ["/auth/login", null],
      ["/auth/refresh", "203.0.113.10"],
      // ما عدا الدخول والتجديد لا يحمل العنوان
      ["/auth/me", null],
    ]);
  });
  it("returns only an opaque HttpOnly host cookie on login, and a write idempotency key", async () => {
    const store = new MemoryStore(); const issued = tokens();
    const result = await handle(request("auth/login", undefined, { email: me.email, password: "synthetic-password" }), "auth/login", { config, store, fetch: transport(r => {
      expect(r.url).toBe(`${config.api}/auth/login`); expect(r.headers.get("Idempotency-Key")).toMatch(/^[a-f0-9-]{36}$/); expect(r.headers.get("cookie")).toBeNull(); return response(issued);
    }) });
    expect(await result.json()).toEqual({ ok: true });
    const cookie = result.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("Secure"); expect(cookie).toContain("SameSite=strict"); expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain(issued.access_token); expect(cookie).not.toContain(issued.refresh_token); expect(result.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects cross-origin writes before contacting the API", async () => {
    let called = false; const result = await handle(request("auth/login", undefined, {}, "https://untrusted.example.test"), "auth/login", { config, store: new MemoryStore(), fetch: transport(() => { called = true; return response({}); }) });
    expect(result.status).toBe(403); expect(called).toBe(false);
  });
  it("does not expose upstream errors, tokens, or form values", async () => {
    const result = await handle(request("auth/login", undefined, { email: me.email, password: "synthetic-password" }), "auth/login", { config, store: new MemoryStore(), fetch: transport(() => response({ code: "unauthorized", message: "protected value", access_token: "secret" }, 401)) });
    expect(await result.json()).toEqual({ code: "login_failed" });
  });
  it("clears the session and cookie immediately on revocation, without reading materials", async () => {
    const store = new MemoryStore(), id = await store.create(tokens()); const calls: string[] = [];
    const result = await handle(request("materials", id), "materials", { config, store, fetch: transport(r => { calls.push(r.url); return response({ code: "unauthorized" }, 401); }) });
    expect(result.status).toBe(401); expect(await result.json()).toEqual({ code: "session_revoked" });
    expect(result.headers.get("set-cookie")).toContain("Max-Age=0"); expect(await store.read(id)).toBeNull(); expect(calls).toEqual([`${config.api}/auth/me`]);
  });
  it("refreshes once for simultaneous requests across BFF handlers", async () => {
    const store = new MemoryStore(), old = { ...tokens(), expires_at: new Date(0).toISOString() }, id = await store.create(old); let refreshes = 0;
    const fetch = transport(async r => {
      if (r.url.endsWith("/auth/refresh")) { refreshes++; expect(await r.json()).toEqual({ refresh_token: old.refresh_token }); return response({ ...tokens(), access_token: "rotated", refresh_token: "rotated-refresh" }); }
      expect(r.headers.get("Authorization")).toBe("Bearer rotated"); return response(me);
    });
    const work = () => withSession(id, store, config, async api => requireOk(await api.GET("/auth/me")), fetch);
    expect(await Promise.all([work(), work(), work()])).toHaveLength(3); expect(refreshes).toBe(1);
  });
  it("never retries a refresh with an unknown response", async () => {
    const store = new MemoryStore(), id = await store.create({ ...tokens(), expires_at: new Date(0).toISOString() }); let calls = 0;
    const fetch = transport(() => { calls++; throw new Error("Network failure with secret"); });
    await expect(withSession(id, store, config, async () => 1, fetch)).rejects.toMatchObject({ status: 401, code: "session_revoked" });
    expect(await store.read(id)).toBeNull(); expect(calls).toBe(1);
  });
  it("preserves the session if the all-device logout is not acknowledged", async () => {
    const store = new MemoryStore(), id = await store.create(tokens());
    const result = await handle(request("auth/logout", id, { all_sessions: true }), "auth/logout", { config, store, fetch: transport(() => response({}, 503)) });
    expect(result.status).toBe(503); expect(await store.read(id)).not.toBeNull(); expect(result.headers.get("set-cookie")).toBeNull();
  });
  it("revokes all sessions only after the explicit all_sessions request and clears local access", async () => {
    const store = new MemoryStore(), id = await store.create(tokens());
    const result = await handle(request("auth/logout", id, { all_sessions: true }), "auth/logout", { config, store, fetch: transport(async r => { expect(await r.json()).toEqual({ all_sessions: true }); return new Response(null, { status: 204 }); }) });
    expect(result.status).toBe(200); expect(await store.read(id)).toBeNull(); expect(result.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("does not provide generic API proxy or material edits", async () => {
    // إنشاء المادة للمراسل مسار صريح في server/uploads.ts (#88)؛ ما عداه من كتابات المواد والنماذج غير موجود.
    const store = new MemoryStore(), id = await store.create(tokens());
    for (const path of ["forms/1", `materials/${material().id}`, "uploads/x/complete"]) {
      const result = await handle(request(path, id, { title: "blocked" }), path, { config, store, fetch: transport(() => { throw new Error("must not call API"); }) });
      expect(result.status).toBe(405);
    }
  });
  it("uses the current permissions, drops GPS and unknown fields before browser delivery", async () => {
    const store = new MemoryStore(), id = await store.create(tokens());
    const result = await handle(request("materials", id), "materials", { config, store, fetch: transport(r => r.url.endsWith("/auth/me") ? response(me) : response({ items: [{ ...material(), gps: { lat: 1, lng: 2 }, protected_source: "canary", dynamic_fields: { source: "canary" }, device_id: "canary" }], next_cursor: null })) });
    const body = await result.json(); expect(body.items[0].gps).toBeUndefined(); expect(JSON.stringify(body)).not.toContain("canary");
  });
});
it("authenticates encrypted Redis session records and detects tampering", () => {
  const value = { tokens: tokens(), deadline: Date.now() + 10000 }, encrypted = seal(value, config.key);
  expect(encrypted).not.toContain(value.tokens.access_token); expect(unseal(encrypted, config.key)).toEqual(value);
  const altered = Buffer.from(encrypted, "base64url"); altered[30] ^= 1;
  expect(() => unseal(altered.toString("base64url"), config.key)).toThrow();
});
