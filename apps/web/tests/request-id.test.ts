import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: ["https://media.example.test"], tusOrigins: [], trustForwardedFor: false };
// من الشكل الذي يقبله الخادم من عنوان الـBFF: [A-Za-z0-9._-]{8,64}
const shape = /^web-[0-9a-f]{32}$/;

async function call(path: string, headers: Record<string, string> = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [];
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { headers: { Cookie: `${config.cookieName}=${id}`, ...headers } });
  const fetch = (async (input: Request) => { calls.push(input); return input.url.endsWith("/auth/me") ? Response.json(me) : new Response(null, { status: 404 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path, { config, store, fetch }), calls };
}

describe("BFF correlation id (ADR 0027)", () => {
  it("sends one generated id with every server call of a request and returns it in its own response", async () => {
    const { result, calls } = await call("forms/current");
    expect(calls.map(c => new URL(c.url).pathname)).toEqual(["/v1/auth/me", "/v1/forms/current"]);
    const ids = calls.map(c => c.headers.get("X-Request-Id"));
    expect(ids[0]).toMatch(shape); expect(ids[1]).toBe(ids[0]);
    expect(result.headers.get("X-Request-Id")).toBe(ids[0]);
  });
  it("gives each request its own id", async () => {
    const first = await call("auth/me"), second = await call("auth/me");
    expect(first.result.status).toBe(200);
    expect(second.result.headers.get("X-Request-Id")).toMatch(shape);
    expect(second.result.headers.get("X-Request-Id")).not.toBe(first.result.headers.get("X-Request-Id"));
  });
  it("never forwards or returns an id sent by the browser", async () => {
    const sent = "browser-chosen-id-0001";
    const { result, calls } = await call("auth/me", { "X-Request-Id": sent });
    expect(calls).toHaveLength(1); expect(calls[0].headers.get("X-Request-Id")).toMatch(shape);
    expect(result.headers.get("X-Request-Id")).toBe(calls[0].headers.get("X-Request-Id"));
  });
  it("puts the id on a response that never reached the server", async () => {
    const refused = (async () => { throw new Error("no server call expected"); }) as typeof globalThis.fetch;
    const result = await handle(new NextRequest(`${config.origin}/api/bff/auth/me`), "auth/me", { config, store: new MemoryStore(), fetch: refused });
    expect(result.status).toBe(401); expect(result.headers.get("X-Request-Id")).toMatch(shape);
  });
});
