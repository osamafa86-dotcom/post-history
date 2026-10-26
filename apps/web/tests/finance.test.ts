import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { commissionInput, currentRules, type CommissionRule, type CommissionRuleInput } from "../src/lib/commission-policy";
import { refundable, refundCreate, type Refund } from "../src/lib/refund-policy";
import type { Order } from "../src/lib/order-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const buyerAdmin: Me = { ...me, organization_id: randomUUID(), roles: [{ name: "buyer_admin", scopes: [] }] }, admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, finance: Me = { ...me, roles: [{ name: "finance", scopes: [] }] }, rights: Me = { ...me, roles: [{ name: "rights_officer", scopes: [] }] };
const input: CommissionRuleInput = { scope: "default", scope_id: null, license_type: null, platform_basis_points: 3000, effective_from: "2026-11-01T00:00:00.000Z" };
const rule = (patch: Partial<CommissionRule>): CommissionRule => ({ ...input, id: randomUUID(), created_by: me.user_id, created_at: "2026-10-20T10:00:00Z", ...patch });

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID() }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (req: Request) => { if (req.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(req); return options.upstream ? options.upstream(req) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("commission rule input", () => {
  it("accepts each scope with its contract-shaped target and rejects the rest", () => {
    expect(commissionInput(input as unknown as Record<string, unknown>)).toEqual(input);
    expect(commissionInput({ ...input, scope: "material_type", scope_id: "aerial", license_type: "commercial" })).not.toBeNull();
    expect(commissionInput({ ...input, scope: "reporter", scope_id: randomUUID(), platform_basis_points: 10000 })).not.toBeNull();
    const bad: Record<string, unknown>[] = [
      { scope_id: randomUUID() }, { scope: "material", scope_id: null }, { scope: "material", scope_id: "aerial" }, { scope: "material_type", scope_id: "drone" },
      { license_type: "subscription" }, { platform_basis_points: -1 }, { platform_basis_points: 10001 }, { platform_basis_points: 12.5 },
      { effective_from: "2026-11-01" }, { effective_from: "not a date" }, { scope: "global" }, { extra: 1 },
    ];
    for (const patch of bad) expect(commissionInput({ ...input, ...patch }), JSON.stringify(patch)).toBeNull();
    expect(commissionInput(Object.fromEntries(Object.entries(input).filter(([key]) => key !== "effective_from")))).toBeNull();
  });
  it("marks the latest effective version per scope and type, not future ones", () => {
    const now = Date.parse("2026-11-15T00:00:00Z");
    const old = rule({ effective_from: "2026-01-01T00:00:00Z" }), live = rule({ effective_from: "2026-11-01T00:00:00Z" }), future = rule({ effective_from: "2027-01-01T00:00:00Z" });
    const typed = rule({ license_type: "commercial", effective_from: "2026-02-01T00:00:00Z" });
    expect([...currentRules([future, old, live, typed], now)].sort()).toEqual([live.id, typed.id].sort());
  });
});

describe("commission rule BFF", () => {
  it("lists for finance through the allowlist and filters by scope only", async () => {
    const { result, calls } = await call("commission-rules?scope=material_type", { method: "GET", user: finance, upstream: () => Response.json({ items: [{ ...rule({ scope: "material_type", scope_id: "aerial" }), note: "canary" }] }) });
    expect(result.status).toBe(200); expect(new URL(calls[0].url).searchParams.get("scope")).toBe("material_type"); expect(await result.text()).not.toContain("canary");
    expect(result.headers.get("Cache-Control")).toContain("no-store");
    for (const query of ["scope=global", "scope=default&scope=material", "limit=5"]) expect((await call(`commission-rules?${query}`, { method: "GET", user: finance })).result.status).toBe(400);
    expect((await call("commission-rules", { method: "GET", user: rights })).result.status).toBe(403);
  });
  it("adds a version for the system admin only, with the idempotency key and a validated body", async () => {
    let sent: unknown;
    const created = await call("commission-rules", { body: input, upstream: async req => { sent = await req.json(); return Response.json({ ...input, id: randomUUID(), created_by: me.user_id, created_at: "2026-10-26T10:00:00Z" }, { status: 201 }); } });
    expect(created.result.status).toBe(201); expect(created.calls[0].headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/); expect(sent).toEqual(input);
    const denied = await call("commission-rules", { body: input, user: finance }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
    const invalid = await call("commission-rules", { body: { ...input, platform_basis_points: 20000 } }); expect(invalid.result.status).toBe(422); expect(invalid.calls).toHaveLength(0);
    for (const method of ["PUT", "DELETE"]) expect((await call("commission-rules", { method, body: input })).calls).toHaveLength(0);
    expect((await call("commission-rules", { body: input, upstream: () => Response.json({ code: "commission_rule_exists" }, { status: 409 }) })).result.status).toBe(409);
  });
});

const orderId = randomUUID(), [a, b] = [randomUUID(), randomUUID()];
const order = { id: orderId, status: "paid", items: [{ id: a }, { id: b }] } as unknown as Order;
const refund = (patch: Partial<Refund>): Refund => ({ id: randomUUID(), order_id: orderId, order_item_ids: [a], amount: { amount_minor: 15000, currency: "USD" }, reason_code: "buyer_request", status: "pending", created_by: me.user_id, created_at: "2026-10-26T10:00:00Z", completed_at: null, ...patch });

describe("refund input", () => {
  it("takes unique order items and a coded reason, never an amount or free text", () => {
    expect(refundCreate({ order_item_ids: [a, b], reason_code: "duplicate" })).toEqual({ order_item_ids: [a, b], reason_code: "duplicate" });
    for (const body of [{ order_item_ids: [], reason_code: "duplicate" }, { order_item_ids: [a, a], reason_code: "duplicate" }, { order_item_ids: ["x"], reason_code: "duplicate" }, { order_item_ids: [a], reason_code: "goodwill" },
      { order_item_ids: [a], reason_code: "other", amount: { amount_minor: 1, currency: "USD" } }, { order_item_ids: [a], reason_code: "other", note: "free text" }, { order_item_ids: Array.from({ length: 21 }, () => randomUUID()), reason_code: "other" }])
      expect(refundCreate(body as Record<string, unknown>), JSON.stringify(body).slice(0, 80)).toBeNull();
  });
  it("offers only the items of a paid order that no pending or succeeded refund holds", () => {
    expect(refundable(order, []).map(i => i.id)).toEqual([a, b]);
    expect(refundable(order, [refund({})]).map(i => i.id)).toEqual([b]);
    expect(refundable(order, [refund({ status: "failed" })]).map(i => i.id)).toEqual([a, b]);
    expect(refundable({ ...order, status: "refunded" }, [])).toEqual([]);
  });
});

describe("refund BFF", () => {
  it("reads refunds for finance and the buyer's admin through the allowlist; not for buyer members", async () => {
    for (const user of [finance, buyerAdmin]) {
      const { result, calls } = await call(`orders/${orderId}/refunds`, { method: "GET", user, upstream: () => Response.json({ items: [{ ...refund({}), provider_reference: "canary" }] }) });
      expect(result.status).toBe(200); expect(new URL(calls[0].url).pathname).toBe(`/v1/orders/${orderId}/refunds`); expect(await result.text()).not.toContain("canary");
    }
    const member: Me = { ...buyerAdmin, roles: [{ name: "buyer_member", scopes: [] }] };
    expect((await call(`orders/${orderId}/refunds`, { method: "GET", user: member })).result.status).toBe(403);
    expect((await call(`orders/${orderId}/refunds?x=1`, { method: "GET", user: finance })).result.status).toBe(404);
  });
  it("lets finance and the system admin refund items, never buyers, with the idempotency key", async () => {
    let sent: unknown;
    const created = await call(`orders/${orderId}/refunds`, { user: finance, body: { order_item_ids: [a], reason_code: "rights_withdrawn" }, upstream: async req => { sent = await req.json(); return Response.json(refund({ reason_code: "rights_withdrawn" }), { status: 201 }); } });
    expect(created.result.status).toBe(201); expect(sent).toEqual({ order_item_ids: [a], reason_code: "rights_withdrawn" }); expect(created.calls[0].headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    const buyer = await call(`orders/${orderId}/refunds`, { user: buyerAdmin, body: { order_item_ids: [a], reason_code: "dispute" } }); expect(buyer.result.status).toBe(403); expect(buyer.calls).toHaveLength(0);
    const free = await call(`orders/${orderId}/refunds`, { user: finance, body: { order_item_ids: [a], reason_code: "dispute", amount: { amount_minor: 1, currency: "USD" } } }); expect(free.result.status).toBe(422); expect(free.calls).toHaveLength(0);
    expect((await call(`orders/${orderId}/refunds`, { user: admin, body: { order_item_ids: [a], reason_code: "dispute" }, upstream: () => Response.json({ code: "already_refunded" }, { status: 409 }) })).result.status).toBe(409);
  });
});
