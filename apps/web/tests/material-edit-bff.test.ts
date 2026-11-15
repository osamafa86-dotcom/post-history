import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Material, Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { MemoryStore } from "./memory-store";
import { material, me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const owner: Me = { ...me, roles: [{ name: "reporter", scopes: [] }] };
const mine = (patch: Partial<Material> = {}): Material => ({ ...material(), reporter_id: owner.user_id, editorial_state: "needs_changes", row_version: 4, ...patch });

async function patch(body: unknown, options: { user?: Me; current?: Material; headers?: Record<string, string>; noMatch?: boolean } = {}) {
  const store = new MemoryStore(), id = await store.create(tokens()), calls: Request[] = [], current = options.current ?? mine();
  const request = new NextRequest(`${config.origin}/api/bff/materials/${current.id}`, { method: "PATCH", headers: { Cookie: `${config.cookieName}=${id}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...(options.noMatch ? {} : { "If-Match": '"4"' }), ...options.headers }, body: JSON.stringify(body) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? owner);
    calls.push(input);
    if (input.method === "GET") return Response.json(current, { headers: { ETag: '"4"' } });
    return Response.json({ ...current, ...(await input.clone().json() as object), row_version: 5 }, { headers: { ETag: '"5"' } });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, `materials/${current.id}`, { config, store, fetch }), calls };
}
const writes = (calls: Request[]) => calls.filter(call => call.method === "PATCH");

describe("the owner's edit of a material through the BFF", () => {
  it("forwards the changed descriptive fields with If-Match and the idempotency key, and returns the new version tag", async () => {
    const { result, calls } = await patch({ title: "  عنوان مصحّح للمادة ", city: "خان يونس" });
    expect(result.status).toBe(200); expect(result.headers.get("ETag")).toBe('"5"');
    const [sent] = writes(calls); expect(sent.url).toMatch(/\/v1\/materials\/[0-9a-f-]{36}$/);
    expect(sent.headers.get("If-Match")).toBe('"4"'); expect(sent.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await sent.json()).toEqual({ title: "عنوان مصحّح للمادة", city: "خان يونس" });
    expect((await result.json() as Material).title).toBe("عنوان مصحّح للمادة");
  });
  it("needs the version tag, and takes no field outside the four", async () => {
    const untagged = await patch({ title: "عنوان مصحّح للمادة" }, { noMatch: true });
    expect(untagged.result.status).toBe(428); expect(writes(untagged.calls)).toHaveLength(0);
    for (const body of [{ priority: "urgent" }, { title: "عنوان مصحّح", sensitivity: { minors: false, injured: false, graphic: false } }, { tags: ["وسم"] }, { dynamic_fields: {} }, { title: "abcd" }, {}]) {
      const refused = await patch(body); expect(refused.result.status).toBe(422); expect(writes(refused.calls)).toHaveLength(0);
    }
  });
  it("is for the material's own reporter, and only before acceptance", async () => {
    const other = await patch({ title: "عنوان مصحّح للمادة" }, { current: mine({ reporter_id: "10000000-0000-4000-8000-0000000000aa" }) });
    expect(other.result.status).toBe(403); expect(writes(other.calls)).toHaveLength(0);
    const staff = await patch({ title: "عنوان مصحّح للمادة" }, { user: { ...me, roles: [{ name: "supervisor", scopes: [] }] } });
    expect(staff.result.status).toBe(403); expect(staff.calls).toHaveLength(0);
    for (const state of ["accepted", "in_production", "final_review", "published", "rejected"] as const) {
      const late = await patch({ title: "عنوان مصحّح للمادة" }, { current: mine({ editorial_state: state }) });
      expect(late.result.status).toBe(409); expect(writes(late.calls)).toHaveLength(0);
    }
    for (const state of ["inbox", "acknowledged", "reviewing", "needs_changes"] as const) expect((await patch({ city: "رفح" }, { current: mine({ editorial_state: state }) })).result.status).toBe(200);
  });
});
