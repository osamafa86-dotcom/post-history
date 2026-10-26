import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { allowedCheckout, orderCreate } from "../src/lib/order-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], checkoutOrigins: ["https://sandbox.pay.example.test"], trustForwardedFor: false };
const org = "90000000-0000-4000-8000-000000000001", listing = "71000000-0000-4000-8000-000000000001", template = "70000000-0000-4000-8000-000000000001", orderId = "92000000-0000-4000-8000-000000000001";
const buyer: Me = { ...me, organization_id: org, roles: [{ name: "buyer_member", scopes: [] }] }, finance: Me = { ...me, roles: [{ name: "finance", scopes: [] }] }, rights: Me = { ...me, roles: [{ name: "rights_officer", scopes: [] }] };
const item = { id: randomUUID(), listing_id: listing, material_version: 1, license_template_id: template, license_version: 1, license_type: "editorial_single", license_name: { ar: "تحريري", en: "Editorial" }, title: { ar: "لقطات", en: "Footage" }, price: { amount_minor: 15000, currency: "USD" }, license_id: null };
const order = { id: orderId, organization_id: org, created_by: me.user_id, status: "pending_payment", cancel_reason: null, total: { amount_minor: 15000, currency: "USD" }, items: [item], expires_at: "2026-10-27T10:00:00Z", paid_at: null, created_at: "2026-10-26T10:00:00Z", updated_at: "2026-10-26T10:00:00Z" };
const body = { items: [{ listing_id: listing, license_template_id: template }], expected_total: { amount_minor: 15000, currency: "USD" } };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response>; cfg?: WebConfig } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (r: Request) => { if (r.url.endsWith("/auth/me")) return Response.json(options.user ?? buyer); calls.push(r); return options.upstream ? options.upstream(r) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config: options.cfg ?? config, store, fetch }), calls };
}

describe("order input and checkout origin", () => {
  it("builds an order from the cart by the contract's rules", () => {
    expect(orderCreate(body)).toEqual(body); expect(orderCreate({ items: body.items })).toEqual({ items: body.items });
    for (const patch of [{ items: [] }, { items: [body.items[0], body.items[0]] }, { items: Array.from({ length: 21 }, () => ({ listing_id: randomUUID(), license_template_id: template })) }, { items: [{ listing_id: "x", license_template_id: template }] }, { items: [{ ...body.items[0], price: 1 }] }, { expected_total: { amount_minor: -1, currency: "USD" } }, { expected_total: { amount_minor: 1, currency: "EUR" } }, { extra: 1 }]) expect(orderCreate({ ...body, ...patch }), JSON.stringify(patch)).toBeNull();
  });
  it("only sends the browser to a configured provider origin", () => {
    expect(allowedCheckout("https://sandbox.pay.example.test/s/abc", config.checkoutOrigins!)).toBe(true);
    for (const value of ["https://evil.example.test/s", "https://user:p@sandbox.pay.example.test/s", "javascript:alert(1)", 7]) expect(allowedCheckout(value, config.checkoutOrigins!)).toBe(false);
  });
  it("adapts to the server's provider: Stripe in test mode only on its hosted origin, nothing outside the contract", () => {
    const origins = ["https://sandbox.pay.example.test", "https://checkout.stripe.com"];
    expect(allowedCheckout("https://checkout.stripe.com/c/pay/cs_test_abc", origins, "stripe")).toBe(true);
    expect(allowedCheckout("https://sandbox.pay.example.test/s/abc", origins, "stripe")).toBe(false);
    expect(allowedCheckout("https://checkout.stripe.com/c/pay/cs_test_abc", origins, "sandbox")).toBe(false);
    expect(allowedCheckout("https://checkout.stripe.com/c/pay/cs_test_abc", ["https://sandbox.pay.example.test"], "stripe")).toBe(false);
    expect(allowedCheckout("https://sandbox.pay.example.test/s/abc", origins, "paypal")).toBe(false);
  });
});

describe("orders BFF", () => {
  it("creates an order for buyers only, with the idempotency key and safe fields", async () => {
    const key = randomUUID();
    const { result, calls } = await call("orders", { body, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json({ ...order, provider_reference: "canary" }, { status: 201 }); } });
    expect(result.status).toBe(201); expect(calls[0].headers.get("Idempotency-Key")).toBe(key); expect(await result.text()).not.toContain("canary");
    for (const user of [finance, rights]) { const denied = await call("orders", { user, body }); expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0); }
    const conflict = await call("orders", { body, upstream: () => Response.json({ code: "price_changed", message: "canary" }, { status: 409 }) });
    expect(conflict.result.status).toBe(409); expect(await conflict.result.text()).not.toContain("canary");
  });
  it("reads orders for buyers and finance and validates filters", async () => {
    const list = await call("orders?status=paid", { method: "GET", user: finance, upstream: () => Response.json({ items: [order], next_cursor: null }) });
    expect(list.result.status).toBe(200); expect(new URL(list.calls[0].url).searchParams.get("status")).toBe("paid");
    expect((await call("orders?status=bogus", { method: "GET" })).result.status).toBe(400);
    expect((await call("orders", { method: "GET", user: rights })).result.status).toBe(403);
    expect((await call(`orders/${orderId}`, { method: "GET", upstream: () => Response.json({ code: "not_found" }, { status: 404 }) })).result.status).toBe(404);
  });
  it("hands over the hosted checkout link only within the configured origins", async () => {
    const ok = await call(`orders/${orderId}/checkout`, { upstream: () => Response.json({ checkout_url: "https://sandbox.pay.example.test/s/abc", provider: "sandbox", expires_at: order.expires_at, secret: "canary" }) });
    expect(ok.result.status).toBe(200); expect(ok.result.headers.get("Cache-Control")).toContain("no-store"); expect(await ok.result.text()).not.toContain("canary");
    const evil = await call(`orders/${orderId}/checkout`, { upstream: () => Response.json({ checkout_url: "https://evil.example.test/s", provider: "sandbox", expires_at: order.expires_at }) });
    expect(evil.result.status).toBe(502); expect(await evil.result.text()).not.toContain("evil");
    const off = await call(`orders/${orderId}/checkout`, { cfg: { ...config, checkoutOrigins: [] }, upstream: () => Response.json({ checkout_url: "https://sandbox.pay.example.test/s/abc", provider: "sandbox", expires_at: order.expires_at }) });
    expect(off.result.status).toBe(502);
    const stripeConfig = { ...config, checkoutOrigins: ["https://sandbox.pay.example.test", "https://checkout.stripe.com"] };
    const stripe = await call(`orders/${orderId}/checkout`, { cfg: stripeConfig, upstream: () => Response.json({ checkout_url: "https://checkout.stripe.com/c/pay/cs_test_abc", provider: "stripe", expires_at: order.expires_at }) });
    expect(stripe.result.status).toBe(200); expect((await stripe.result.json()).provider).toBe("stripe");
    const unknown = await call(`orders/${orderId}/checkout`, { cfg: stripeConfig, upstream: () => Response.json({ checkout_url: "https://sandbox.pay.example.test/s/abc", provider: "paypal", expires_at: order.expires_at }) });
    expect(unknown.result.status).toBe(502);
    const cancelled = await call(`orders/${orderId}/cancel`, { upstream: () => Response.json({ ...order, status: "cancelled", cancel_reason: "buyer" }) });
    expect((await cancelled.result.json()).status).toBe("cancelled");
    expect((await call(`orders/${orderId}/cancel`, { body: { reason: "x" } })).result.status).toBe(422);
  });
});
