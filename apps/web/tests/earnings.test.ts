import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { approvable, payoutCreate, payoutReject, policyInput, type PayoutRequest } from "../src/lib/earnings-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const reporter: Me = { ...me, roles: [{ name: "reporter", scopes: [] }] }, finance: Me = { ...me, user_id: randomUUID(), roles: [{ name: "finance", scopes: [] }] }, admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] };
const usd = (n: number) => ({ amount_minor: n, currency: "USD" as const });
const payout = (patch: Partial<PayoutRequest> = {}): PayoutRequest => ({ id: randomUUID(), user_id: me.user_id, amount: usd(8000), channel: "sandbox", state: "requested", reason_code: null, approvals_required: 1, approvals: [], requested_at: "2026-10-26T10:00:00Z", decided_at: null, completed_at: null, ...patch });

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID() }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (req: Request) => { if (req.url.endsWith("/auth/me")) return Response.json(options.user ?? reporter); calls.push(req); return options.upstream ? options.upstream(req) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("earnings inputs", () => {
  it("takes a positive sandbox amount and nothing about a bank account", () => {
    expect(payoutCreate({ amount: usd(5000), channel: "sandbox" })).toEqual({ amount: usd(5000), channel: "sandbox" });
    for (const body of [{ amount: usd(0), channel: "sandbox" }, { amount: usd(5000), channel: "bank" }, { amount: { amount_minor: 1, currency: "EUR" }, channel: "sandbox" }, { amount: usd(5000), channel: "sandbox", iban: "PS00" }, { amount: usd(-1), channel: "sandbox" }])
      expect(payoutCreate(body as Record<string, unknown>), JSON.stringify(body)).toBeNull();
  });
  it("rejects with a coded reason only, and policies in their own currency", () => {
    expect(payoutReject({ reason_code: "policy" })).toEqual({ reason_code: "policy" }); expect(payoutReject({ reason_code: "policy", note: "x" })).toBeNull(); expect(payoutReject({ reason_code: "whim" })).toBeNull();
    const policy = { currency: "USD", minimum: usd(5000), dual_approval_above: usd(100000), reserve_bps: 1000, effective_from: "2026-11-01T00:00:00.000Z" };
    expect(policyInput(policy)).toEqual(policy);
    for (const patch of [{ minimum: { amount_minor: 1, currency: "ILS" } }, { reserve_bps: 5001 }, { effective_from: "tomorrow" }, { extra: 1 }]) expect(policyInput({ ...policy, ...patch }), JSON.stringify(patch)).toBeNull();
  });
  it("never offers self-approval or a second approval by the same person", () => {
    expect(approvable(payout({ user_id: randomUUID() }), me.user_id)).toBe(true);
    expect(approvable(payout(), me.user_id)).toBe(false);
    expect(approvable(payout({ user_id: randomUUID(), approvals_required: 2, approvals: [{ approver_id: me.user_id, approved_at: "2026-10-26T11:00:00Z" }] }), me.user_id)).toBe(false);
    expect(approvable(payout({ user_id: randomUUID(), state: "approved" }), me.user_id)).toBe(false);
  });
});

describe("earnings BFF", () => {
  it("reads the reporter's own balances and statement through the allowlist", async () => {
    const summary = await call("me/earnings", { method: "GET", upstream: () => Response.json({ user_id: me.user_id, as_of: "2026-10-26T10:00:00Z", balances: [{ currency: "USD", pending: usd(1), available: usd(2), in_payout: usd(0), paid: usd(0), reserve: usd(0), requestable: usd(2), minimum: usd(1), note: "canary" }], internal: "canary" }) });
    expect(summary.result.status).toBe(200); expect(await summary.result.text()).not.toContain("canary");
    const entries = await call("me/earnings/entries?currency=USD&state=available", { method: "GET", upstream: () => Response.json({ items: [{ id: "1", entry_id: randomUUID(), kind: "sale", state: "available", amount: usd(10), reference_type: "order", reference_id: randomUUID(), occurred_at: "2026-10-26T10:00:00Z", buyer_name: "canary" }], next_cursor: null }) });
    expect(new URL(entries.calls[0].url).searchParams.get("state")).toBe("available"); expect(await entries.result.text()).not.toContain("canary");
    for (const query of ["currency=EUR", "state=frozen", "other=1"]) expect((await call(`me/earnings/entries?${query}`, { method: "GET" })).result.status).toBe(400);
    expect((await call("me/earnings", { method: "GET", user: finance })).result.status).toBe(403);
  });
  it("hides approver ids from the requester and shows them to finance", async () => {
    const approved = payout({ approvals: [{ approver_id: finance.user_id, approved_at: "2026-10-26T11:00:00Z" }] });
    const own = await call("me/payout-requests", { method: "GET", upstream: () => Response.json({ items: [approved], next_cursor: null }) });
    expect(await own.result.text()).not.toContain(finance.user_id);
    const staff = await call("payout-requests?state=requested", { method: "GET", user: finance, upstream: () => Response.json({ items: [approved], next_cursor: null }) });
    expect(await staff.result.text()).toContain(finance.user_id);
    expect((await call("payout-requests", { method: "GET" })).result.status).toBe(403);
    expect((await call(`users/${randomUUID()}/earnings`, { method: "GET" })).result.status).toBe(403);
    expect((await call(`users/${randomUUID()}/earnings`, { method: "GET", user: finance, upstream: () => Response.json({ user_id: me.user_id, balances: [], as_of: "2026-10-26T10:00:00Z" }) })).result.status).toBe(200);
  });
  it("routes each write to its role with an idempotency key and a closed body", async () => {
    let sent: unknown;
    const created = await call("me/payout-requests", { body: { amount: usd(5000), channel: "sandbox" }, upstream: async req => { sent = await req.json(); return Response.json(payout({ amount: usd(5000) }), { status: 201 }); } });
    expect(created.result.status).toBe(201); expect(sent).toEqual({ amount: usd(5000), channel: "sandbox" }); expect(created.calls[0].headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call("me/payout-requests", { body: { amount: usd(5000), channel: "sandbox" }, user: finance })).calls).toHaveLength(0);
    const id = randomUUID();
    expect((await call(`payout-requests/${id}/cancel`, { upstream: () => Response.json(payout({ state: "cancelled" })) })).result.status).toBe(200);
    expect((await call(`payout-requests/${id}/approve`)).calls).toHaveLength(0);
    expect((await call(`payout-requests/${id}/approve`, { user: finance, upstream: () => Response.json(payout({ state: "approved" })) })).result.status).toBe(200);
    expect((await call(`payout-requests/${id}/reject`, { user: finance, body: { reason_code: "other", note: "free" } })).result.status).toBe(422);
    expect((await call(`payout-requests/${id}/approve`, { user: finance, upstream: () => Response.json({ code: "self_approval_forbidden" }, { status: 409 }) })).result.status).toBe(409);
    const policy = { currency: "USD", minimum: usd(5000), dual_approval_above: usd(100000), reserve_bps: 1000, effective_from: "2026-11-01T00:00:00.000Z" };
    expect((await call("payout-policies", { user: finance, body: policy })).calls).toHaveLength(0);
    expect((await call("payout-policies", { user: admin, body: policy, upstream: () => Response.json({ ...policy, id: randomUUID(), created_by: me.user_id, created_at: "2026-10-26T10:00:00Z" }, { status: 201 }) })).result.status).toBe(201);
  });
});
