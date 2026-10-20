import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { material, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: ["https://media.example.test"] };
const fixture = material(), file = fixture.files[0];
const path = `materials/${fixture.id}/files/${file.id}/content`;
async function setup(options: { kind?: typeof file.kind; state?: typeof file.state; url?: string; expiry?: number; revoked?: boolean; mime?: string; slowCancel?: boolean } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens());
  const calls: Request[] = [];
  let signed = 0;
  const transport = (async (input: RequestInfo | URL) => {
    const request = input as Request; calls.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/auth/me")) return Response.json(options.revoked ? {} : me, { status: options.revoked ? 401 : 200 });
    if (url.pathname.endsWith(`/materials/${fixture.id}`)) return Response.json({ ...fixture, files: [{ ...file, kind: options.kind ?? "proxy", state: options.state ?? "verified" }] });
    if (url.pathname.endsWith("/download-url")) { signed++; return Response.json({ url: options.url ?? `https://media.example.test/derived/123?signature=synthetic-${signed}`, expires_at: new Date(Date.now() + (options.expiry ?? 300000)).toISOString() }); }
    const body = options.slowCancel ? new ReadableStream({ cancel: () => new Promise(() => {}) }) : new Uint8Array([1, 2, 3]);
    return new Response(body, { status: 206, headers: { "Content-Type": options.mime ?? "video/mp4", "Content-Length": "3", "Content-Range": "bytes 0-2/100", "Accept-Ranges": "bytes", "Set-Cookie": "must-not-forward=1", "Content-Disposition": "attachment; filename=private-name.mp4" } });
  }) as typeof fetch;
  const run = (range = "bytes=0-2") => handle(new NextRequest(`${config.origin}/api/bff/${path}`, { headers: { Cookie: `${config.cookieName}=${id}`, Range: range } }), path, { config, store, fetch: transport });
  return { run, calls, store, id };
}

describe("authenticated derivative streaming", () => {
  it("streams a verified proxy with Range, no API credentials to storage and no signed URL to the browser", async () => {
    const { run, calls } = await setup(); const result = await run();
    expect(result.status).toBe(206); expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(result.headers.get("content-range")).toBe("bytes 0-2/100"); expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.get("set-cookie")).toBeNull(); expect(result.headers.get("content-disposition")).toBeNull();
    expect(JSON.stringify([...result.headers])).not.toContain("signature");
    const storage = calls.at(-1)!; expect(storage.headers.get("range")).toBe("bytes=0-2");
    for (const key of ["authorization", "cookie", "referer"]) expect(storage.headers.get(key)).toBeNull();
    expect(storage.redirect).toBe("error");
  });
  it.each(["original", "voice_note"] as const)("never signs or fetches a %s", async kind => {
    const { run, calls } = await setup({ kind }); expect((await run()).status).toBe(404);
    expect(calls.some(r => r.url.includes("download-url") || r.url.startsWith(config.mediaOrigins[0]))).toBe(false);
  });
  it("rejects an unverified derivative", async () => {
    const { run, calls } = await setup({ state: "uploading" }); expect((await run()).status).toBe(404); expect(calls).toHaveLength(2);
  });
  it.each(["https://attacker.example.test/secret", "https://media.example.test.attacker.test/secret", "https://name:password@media.example.test/secret", "http://media.example.test/secret"])("rejects non-allowlisted or credential-bearing URLs", async url => {
    const { run, calls } = await setup({ url }); const result = await run(); expect(result.status).toBe(503); expect(calls).toHaveLength(3); expect(await result.text()).not.toContain(url);
  });
  it.each([-1, 601000])("rejects expired or excessive lifetime links", async expiry => {
    const { run, calls } = await setup({ expiry }); expect((await run()).status).toBe(503); expect(calls).toHaveLength(3);
  });
  it("obtains a new signed link for every subsequent range request", async () => {
    const { run, calls } = await setup(); await (await run()).arrayBuffer(); await (await run()).arrayBuffer();
    const storage = calls.filter(r => r.url.startsWith(config.mediaOrigins[0])); expect(storage).toHaveLength(2); expect(storage[0].url).not.toBe(storage[1].url);
  });
  it("does not turn a storage response into active HTML", async () => {
    const { run } = await setup({ mime: "text/html" }); expect((await run()).status).toBe(503);
  });
  it("does not hold the session lock while a rejected storage body waits to cancel", async () => {
    const { run } = await setup({ mime: "text/html", slowCancel: true });
    const result = await Promise.race([run(), new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
    expect(result?.status).toBe(503);
  });
  it("rejects multiple ranges without reaching storage", async () => {
    const { run, calls } = await setup(); expect((await run("bytes=0-1,3-4")).status).toBe(416); expect(calls).toHaveLength(1);
  });
  it("checks revocation before signing and clears the session", async () => {
    const { run, calls, store, id } = await setup({ revoked: true }); const result = await run();
    expect(result.status).toBe(401); expect(result.headers.get("set-cookie")).toContain("Max-Age=0"); expect(calls).toHaveLength(1); expect(await store.read(id)).toBeNull();
  });
});
