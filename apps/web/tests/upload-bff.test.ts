import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { allowedTusEndpoint, fileKey, withinEndpoint } from "../src/lib/upload-policy";
import { streamSha256 } from "../src/lib/sha256-stream";
import { retryDecision } from "../src/lib/desktop-upload";
import { MemoryStore } from "./memory-store";
import { form, material, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: ["https://ingest.example.test"], trustForwardedFor: false };
const reporter: Me = { ...me, roles: [{ name: "reporter", scopes: [] }] };
const producer: Me = { ...me, roles: [{ name: "producer", scopes: [] }] };
const item = material(), sessionId = "70000000-0000-4000-8000-000000000001", sha = "a".repeat(64);
const created = {
  id: sessionId, material_id: item.id, kind: "original", state: "created", size_bytes: 4096, tus_endpoint: "https://ingest.example.test/files/",
  tus_metadata: { upload_session_id: sessionId, "bad key": "x" }, part_size_bytes: 16777216, bytes_received: 0, ingest_token_required: true, ietf_resumable: false,
  checksum_algorithm: "sha256", expires_at: "2026-10-26T09:40:03Z", created_at: "2026-10-21T09:40:03Z", upload_token: "upload-secret", upload_token_expires_at: "2026-10-21T10:40:03Z",
  file_id: null, duplicate_of_file_id: null, failure_reason: null, receipt_number: null,
};
const uploadBody = { material_id: item.id, kind: "original", size_bytes: 4096, filename: "A001C002.MOV", mime_type: "video/quicktime", client_sha256: sha, client_fingerprint: { size_bytes: 4096, head_sha256: sha, tail_sha256: sha } };
const materialBody = { title: "مادة من الحاسوب", material_types: ["raw_footage"], governorate: "غزة", city: "خان يونس", priority: "normal", sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" }, form_version: form.version, dynamic_fields: {} };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response>; cfg?: WebConfig } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [];
  const method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? reporter);
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config: options.cfg ?? config, store, fetch }), calls };
}

describe("desktop upload BFF", () => {
  it("creates a material from the reporter form without location or contributors", async () => {
    const { result, calls } = await call("materials", { body: materialBody, upstream: async r => { expect(await r.json()).toEqual(materialBody); return Response.json({ ...item, gps: { lat: 1, lng: 2 } }, { status: 201 }); } });
    expect(result.status).toBe(201); expect(calls[0].url).toBe("https://api.example.test/v1/materials"); expect(await result.text()).not.toContain("lat");
    for (const extra of [{ gps: { lat: 1, lng: 2 } }, { contributors: [] }, { title: "abc" }, { material_types: ["unknown"] }, { display_name: { mode: "pseudonym" } }]) {
      const rejected = await call("materials", { body: { ...materialBody, ...extra } });
      expect(rejected.result.status).toBe(422); expect(rejected.calls).toHaveLength(0);
    }
  });
  it("is open to the contract upload roles and closed to others", async () => {
    const allowed = await call("uploads", { user: producer, body: uploadBody, upstream: () => Response.json(created, { status: 201 }) });
    expect(allowed.result.status).toBe(201);
    const { result, calls } = await call("uploads", { user: { ...me, roles: [{ name: "system_admin", scopes: [] }] }, body: uploadBody });
    expect(result.status).toBe(403); expect(calls).toHaveLength(0);
  });
  it("forwards the same idempotency key and returns only the allowed tus fields", async () => {
    const key = randomUUID();
    const { result, calls } = await call("uploads", { body: uploadBody, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual(uploadBody); return Response.json(created, { status: 201 }); } });
    expect(result.status).toBe(201); expect(calls[0].headers.get("Idempotency-Key")).toBe(key);
    const data = await result.json();
    expect(data).toMatchObject({ id: sessionId, tus_endpoint: created.tus_endpoint, part_size_bytes: 16777216, ingest_token_required: true, upload_token: "upload-secret", tus_metadata: { upload_session_id: sessionId } });
    expect(data.tus_metadata).not.toHaveProperty("bad key"); expect(data).not.toHaveProperty("filename"); expect(data).not.toHaveProperty("duplicate_of_file_id");
    expect(result.headers.get("Cache-Control")).toContain("no-store");
  });
  it("refuses to hand the upload token to an endpoint outside the configured origins", async () => {
    const { result } = await call("uploads", { body: uploadBody, upstream: () => Response.json({ ...created, tus_endpoint: "https://elsewhere.example.test/files/" }, { status: 201 }) });
    expect(result.status).toBe(502); expect(await result.text()).not.toContain("upload-secret");
    const disabled = await call("uploads", { body: uploadBody, cfg: { ...config, tusOrigins: [] }, upstream: () => Response.json(created, { status: 201 }) });
    expect(disabled.result.status).toBe(502);
  });
  it.each([
    [{ kind: "proxy" }], [{ client_sha256: null }], [{ client_sha256: "A".repeat(64) }], [{ filename: "../x.mov" }], [{ size_bytes: 0 }], [{ storage_key: "x" }],
    [{ client_fingerprint: { size_bytes: 1, head_sha256: sha, tail_sha256: sha } }],
  ])("rejects an invalid upload request %j before the API", async patch => {
    const { result, calls } = await call("uploads", { body: { ...uploadBody, ...patch } });
    expect(result.status).toBe(422); expect(calls).toHaveLength(0);
  });
  it("requests the web ingest token for the upload session and maps a revoked login to 401", async () => {
    const ok = await call(`uploads/${sessionId}/web-ingest-token`, { upstream: () => Response.json({ token: "jwt", expires_at: "2026-10-21T10:00:00Z", extra: "x" }) });
    expect(await ok.result.json()).toEqual({ token: "jwt", expires_at: "2026-10-21T10:00:00Z" });
    expect(ok.calls[0].url).toBe(`https://api.example.test/v1/uploads/${sessionId}/web-ingest-token`);
    const revoked = await call(`uploads/${sessionId}/web-ingest-token`, { upstream: () => new Response(null, { status: 401 }) });
    expect(revoked.result.status).toBe(401); expect(await revoked.result.json()).toEqual({ code: "session_revoked" });
    const closed = await call(`uploads/${sessionId}/web-ingest-token`, { upstream: () => Response.json({ message: "canary" }, { status: 409 }) });
    expect(closed.result.status).toBe(409); expect(await closed.result.text()).not.toContain("canary");
  });
  it("reads upload state without the tus endpoint or file names", async () => {
    const { result } = await call(`uploads/${sessionId}`, { method: "GET", upstream: () => Response.json({ ...created, state: "verified", receipt_number: "R-261021-000001", tus_metadata: { filename: "secret.mov", upload_session_id: sessionId } }) });
    const data = await result.json();
    expect(data).toMatchObject({ state: "verified", receipt_number: "R-261021-000001" }); expect(JSON.stringify(data)).not.toContain("secret.mov"); expect(data).not.toHaveProperty("upload_token");
  });
  it("requires CSRF headers on upload writes", async () => {
    const { result, calls } = await call("uploads", { body: uploadBody, headers: { Origin: "https://other.example.test" } });
    expect(result.status).toBe(403); expect(calls).toHaveLength(0);
  });
});

describe("upload policy", () => {
  it("keeps tokens within the configured endpoint", () => {
    expect(allowedTusEndpoint("https://ingest.example.test/files/", ["https://ingest.example.test"])).toBe(true);
    for (const value of ["https://ingest.example.test/files", "https://user:p@ingest.example.test/files/", "https://ingest.example.test/files/?x=1", "http://ingest.example.test/files/", 7]) expect(allowedTusEndpoint(value, ["https://ingest.example.test"])).toBe(false);
    expect(withinEndpoint("https://ingest.example.test/files/abc", "https://ingest.example.test/files/")).toBe(true);
    for (const value of ["https://evil.example.test/files/abc", "https://ingest.example.test/other/abc", "https://ingest.example.test/files/"]) expect(withinEndpoint(value, "https://ingest.example.test/files/")).toBe(false);
    expect(fileKey({ name: "A.MOV", size: 3, lastModified: 9 })).toBe("3:9:A.MOV");
  });
  it("maps gate responses to a retry decision", () => {
    expect(retryDecision(401)).toBe("refresh_token"); expect(retryDecision(403)).toBe("stop"); expect(retryDecision(404)).toBe("stop");
    expect(retryDecision(409)).toBe("default"); expect(retryDecision(undefined)).toBe("default"); expect(retryDecision(500)).toBe("default");
  });
  it("hashes in slices to the same digest as the whole buffer", async () => {
    const bytes = randomBytes(5 * 1024 * 1024 + 17), seen: number[] = [];
    const hex = await streamSha256(new Blob([bytes]), n => seen.push(n), undefined, 1024 * 1024);
    expect(hex).toBe(createHash("sha256").update(bytes).digest("hex")); expect(seen.at(-1)).toBe(bytes.length); expect(seen).toHaveLength(6);
  });
});
