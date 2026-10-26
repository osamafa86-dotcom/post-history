import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { emptyOrganization, memberInvite, memberUpdate, organizationCreate, organizationInput } from "../src/lib/buyer-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const org = "90000000-0000-4000-8000-000000000001", other = "90000000-0000-4000-8000-000000000002", member = "91000000-0000-4000-8000-000000000001";
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, finance: Me = { ...me, roles: [{ name: "finance", scopes: [] }] };
const buyerAdmin: Me = { ...me, organization_id: org, roles: [{ name: "buyer_admin", scopes: [] }] }, buyerMember: Me = { ...buyerAdmin, roles: [{ name: "buyer_member", scopes: [] }] };
const profile = { legal_name: "شركة الأخبار المحدودة", display_name: { ar: "شبكة الأخبار", en: "News Network" }, country: "QA", billing_email: "billing@example.test", seats: 5, status: "active" as const };
const stored = { ...profile, id: org, active_members: 2, verified_at: "2026-10-22T10:00:00Z", created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-22T10:00:00Z" };
const memberRow = { user_id: member, email: "editor@example.test", role: "buyer_member", status: "active", totp_enabled: true, created_at: "2026-10-22T10:00:00Z" };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (r: Request) => { if (r.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(r); return options.upstream ? options.upstream(r) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("buyer organization input", () => {
  it("accepts the contract's fields and rejects the rest", () => {
    expect(organizationInput(profile)).toEqual(profile);
    expect(organizationCreate({ ...emptyOrganization(), ...profile, first_admin_email: "admin@example.test" })).toMatchObject({ first_admin_email: "admin@example.test", seats: 5 });
    for (const patch of [{ country: "qa" }, { billing_email: "x" }, { seats: 0 }, { seats: 1001 }, { status: "deleted" }, { display_name: { ar: "اسم" } }, { legal_name: " " }, { extra: 1 }]) expect(organizationInput({ ...profile, ...patch }), JSON.stringify(patch)).toBeNull();
    expect(organizationCreate(profile)).toBeNull();
    expect(memberInvite({ email: "a@example.test", role: "buyer_admin" })).not.toBeNull(); expect(memberInvite({ email: "a@example.test", role: "system_admin" })).toBeNull();
    expect(memberUpdate({ role: "buyer_member", status: "suspended" })).not.toBeNull(); expect(memberUpdate({ role: "buyer_member", status: "invited" })).toBeNull();
  });
});

describe("buyer organization BFF", () => {
  it("lists organizations for admins and finance only, with safe fields", async () => {
    const { result, calls } = await call("buyer-organizations?status=active", { method: "GET", user: finance, upstream: () => Response.json({ items: [{ ...stored, internal: "canary" }], next_cursor: null }) });
    expect(result.status).toBe(200); expect(new URL(calls[0].url).searchParams.get("status")).toBe("active"); expect(await result.text()).not.toContain("canary");
    expect((await call("buyer-organizations", { method: "GET", user: buyerAdmin })).result.status).toBe(403);
    expect((await call("buyer-organizations?status=deleted", { method: "GET" })).result.status).toBe(400);
  });
  it("keeps a buyer inside their own organization without asking the API", async () => {
    const own = await call(`buyer-organizations/${org}`, { method: "GET", user: buyerMember, upstream: () => Response.json(stored, { headers: { ETag: '"3"' } }) });
    expect(own.result.status).toBe(200); expect(own.result.headers.get("ETag")).toBe('"3"');
    for (const path of [`buyer-organizations/${other}`, `buyer-organizations/${other}/members`]) { const { result, calls } = await call(path, { method: "GET", user: buyerAdmin }); expect(result.status).toBe(404); expect(calls).toHaveLength(0); }
    const write = await call(`buyer-organizations/${other}/members`, { user: buyerAdmin, body: { email: "a@example.test", role: "buyer_member" } }); expect(write.result.status).toBe(404); expect(write.calls).toHaveLength(0);
    expect((await call(`buyer-organizations/${org}/members`, { method: "GET", user: buyerMember })).result.status).toBe(403);
  });
  it("creates for the system admin only and drops anything outside the organization fields", async () => {
    const body = { ...profile, first_admin_email: "admin@example.test" };
    const token = { invite_token: "t".repeat(40), invite_token_expires_at: "2026-10-27T10:00:00Z" };
    const { result, calls } = await call("buyer-organizations", { body, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json({ ...stored, ...token, internal: "canary" }, { status: 201 }); } });
    expect(result.status).toBe(201); expect(calls[0].headers.get("Idempotency-Key")).toBeTruthy(); expect(result.headers.get("Cache-Control")).toContain("no-store");
    const data = await result.json(); expect(data).toMatchObject(token); expect(JSON.stringify(data)).not.toContain("canary");
    // تكرار بمفتاح منع التكرار: الخادم لا يعيد الرمز، والـBFF لا يختلقه؛ ورمز بلا موعد انتهاء لا يمر.
    for (const replay of [stored, { ...stored, invite_token: "t".repeat(40) }, { ...stored, invite_token: "short", invite_token_expires_at: token.invite_token_expires_at }]) {
      const again = await call("buyer-organizations", { body, upstream: () => Response.json(replay, { status: 201 }) });
      expect(await again.result.json()).not.toHaveProperty("invite_token");
    }
    for (const user of [finance, buyerAdmin]) { const denied = await call("buyer-organizations", { user, body }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0); }
  });
  it("edits the profile with If-Match and manages members for the organization admin", async () => {
    const edited = await call(`buyer-organizations/${org}`, { method: "PUT", user: buyerAdmin, body: profile, headers: { "If-Match": '"3"' }, upstream: () => Response.json(stored, { headers: { ETag: '"4"' } }) });
    expect(edited.result.status).toBe(200); expect(edited.calls[0].headers.get("If-Match")).toBe('"3"'); expect(edited.result.headers.get("ETag")).toBe('"4"');
    expect((await call(`buyer-organizations/${org}`, { method: "PUT", user: buyerAdmin, body: profile })).result.status).toBe(428);
    expect((await call(`buyer-organizations/${org}`, { method: "PUT", user: buyerMember, body: profile, headers: { "If-Match": '"3"' } })).result.status).toBe(403);
    const invited = await call(`buyer-organizations/${org}/members`, { user: buyerAdmin, body: { email: "new@example.test", role: "buyer_member" }, upstream: () => Response.json({ ...memberRow, status: "invited", invite_token: "t".repeat(40), invite_token_expires_at: "2026-10-27T10:00:00Z", password_hash: "canary" }, { status: 201 }) });
    expect(invited.result.status).toBe(201); const created = await invited.result.json(); expect(created.invite_token).toBe("t".repeat(40)); expect(JSON.stringify(created)).not.toContain("canary");
    const listed = await call(`buyer-organizations/${org}/members`, { method: "GET", user: buyerAdmin, upstream: () => Response.json({ items: [{ ...memberRow, invite_token: "t".repeat(40) }] }) });
    expect(await listed.result.text()).not.toContain("tttt");
    const full = await call(`buyer-organizations/${org}/members`, { user: buyerAdmin, body: { email: "new@example.test", role: "buyer_member" }, upstream: () => Response.json({ code: "seats_exhausted", message: "canary" }, { status: 409 }) });
    expect(full.result.status).toBe(409); expect(await full.result.text()).not.toContain("canary");
    const updated = await call(`buyer-organizations/${org}/members/${member}`, { method: "PUT", user: buyerAdmin, body: { role: "buyer_admin", status: "active" }, upstream: () => Response.json({ ...memberRow, role: "buyer_admin" }) });
    expect(updated.result.status).toBe(200);
    expect((await call(`buyer-organizations/${org}/members/${member}`, { method: "PUT", user: buyerAdmin, body: { role: "owner", status: "active" } })).result.status).toBe(422);
  });
});
