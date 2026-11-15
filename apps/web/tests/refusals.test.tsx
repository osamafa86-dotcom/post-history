import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { refusalCodes, refusalFromBody, refusalOf } from "../src/lib/refusal-policy";
import { delivered } from "../src/lib/license-policy";
import { ActionStatus } from "../src/components/action-status";
import { ListingConditions } from "../src/components/listing-panel";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], checkoutOrigins: [], trustForwardedFor: false };
const org = "90000000-0000-4000-8000-000000000001", material = "20000000-0000-4000-8000-000000000001", template = "70000000-0000-4000-8000-000000000001";
const buyerAdmin: Me = { ...me, organization_id: org, roles: [{ name: "buyer_admin", scopes: [] }] }, rights: Me = { ...me, roles: [{ name: "rights_officer", scopes: [] }] };
async function call(path: string, method: string, body: unknown, user: Me, upstream: () => Response) {
  const store = new MemoryStore(), session = await store.create(tokens());
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), "If-Match": '"1"' }, body: JSON.stringify(body) });
  const fetch = (async (r: Request) => r.url.endsWith("/auth/me") ? Response.json(user) : upstream()) as typeof globalThis.fetch;
  const result = await handle(request, path, { config, store, fetch });
  return { status: result.status, body: await result.json() };
}
const listing = { title: { ar: "ع", en: "T" }, description: { ar: "و", en: "d" }, state: "listed", offers: [{ license_template_id: template, price_override: null }] };

describe("refusal codes that pass the BFF (coordinator decision 2026-11-15)", () => {
  it("passes the whitelisted codes alone, the failed listing conditions by name, and nothing else", () => {
    for (const code of ["rights_not_sellable", "price_changed", "listing_unavailable", "exclusive_unavailable", "order_state_conflict", "seats_exhausted", "last_buyer_admin"]) expect(refusalOf(409, { code, message: "canary" })).toEqual({ code });
    expect(refusalOf(422, { code: "mixed_currency", details: { fields: ["/items"] } })).toEqual({ code: "mixed_currency" });
    expect(refusalOf(409, { code: "listing_conditions_unmet", details: { failed: ["editorial_state", "technical_state", "canary"] } })).toEqual({ code: "listing_conditions_unmet", failed: ["editorial_state", "technical_state"] });
    // البريد القائم يرده الخادم 409 bad_request بحقل البريد
    expect(refusalOf(409, { code: "bad_request", details: { fields: ["/email"] } })).toEqual({ code: "email_taken" });
    expect(refusalOf(409, { code: "bad_request", details: { fields: ["/role"] } })).toBeNull();
    // الحساسية: 422 بحقل الحالة على كتابة الإدراج وحدها
    expect(refusalOf(422, { code: "validation_failed", details: { fields: ["/state"] } }, { listing: true })).toEqual({ code: "listing_sensitive" });
    expect(refusalOf(422, { code: "validation_failed", details: { fields: ["/state"] } })).toBeNull();
    for (const other of [{ code: "canary" }, null, "text", { message: "price_changed" }]) expect(refusalOf(409, other)).toBeNull();
    expect(refusalOf(409, { code: "invalid_transition" })).toBeNull(); expect(refusalOf(403, { code: "price_changed" })).toBeNull();
  });
  it("reads a refusal in the browser from the BFF body only when it is on the list", () => {
    expect(refusalFromBody({ code: "seats_exhausted" })).toEqual({ code: "seats_exhausted" });
    expect(refusalFromBody({ code: "listing_conditions_unmet", details: { failed: ["technical_state", "x"] } })).toEqual({ code: "listing_conditions_unmet", failed: ["technical_state"] });
    for (const bad of [{ code: "request_failed" }, { code: "canary" }, null, undefined, "seats_exhausted"]) expect(refusalFromBody(bad)).toBeNull();
    expect(new Set(refusalCodes).size).toBe(refusalCodes.length);
  });
  it("every code has its sentence in both languages, and the status line shows it instead of the generic one", () => {
    for (const code of refusalCodes) { expect(ar.refusals[code]).toBeTruthy(); expect(en.refusals[code]).toBeTruthy(); }
    const html = renderToStaticMarkup(<ActionStatus status={409} locale="en" refusal={{ code: "listing_conditions_unmet", failed: ["editorial_state", "technical_state"] }} />);
    expect(html).toContain(en.refusals.listing_conditions_unmet.split("{conditions}")[0]); expect(html).toContain(en.listing.conditions.editorial_state); expect(html).toContain(en.listing.conditions.technical_state);
    expect(html).not.toContain(en.review.conflict);
    expect(renderToStaticMarkup(<ActionStatus status={409} locale="ar" refusal={{ code: "seats_exhausted" }} />)).toContain(ar.refusals.seats_exhausted);
    expect(renderToStaticMarkup(<ActionStatus status={409} locale="ar" />)).toContain(ar.review.conflict);
  });
  it("the BFF passes the code on the order, member and listing writes, never the server's message", async () => {
    const order = await call("orders", "POST", { items: [{ listing_id: "71000000-0000-4000-8000-000000000001", license_template_id: template }] }, buyerAdmin, () => Response.json({ code: "exclusive_unavailable", message: "canary" }, { status: 409 }));
    expect(order).toEqual({ status: 409, body: { code: "exclusive_unavailable" } });
    const invite = await call(`buyer-organizations/${org}/members`, "POST", { email: "new@example.test", role: "buyer_member" }, buyerAdmin, () => Response.json({ code: "bad_request", message: "canary", details: { fields: ["/email"] } }, { status: 409 }));
    expect(invite).toEqual({ status: 409, body: { code: "email_taken" } });
    const demote = await call(`buyer-organizations/${org}/members/${me.user_id}`, "PUT", { role: "buyer_member", status: "active" }, buyerAdmin, () => Response.json({ code: "last_buyer_admin", message: "canary" }, { status: 409 }));
    expect(demote).toEqual({ status: 409, body: { code: "last_buyer_admin" } });
    const unmet = await call(`materials/${material}/listing`, "PUT", listing, rights, () => Response.json({ code: "listing_conditions_unmet", message: "canary", details: { failed: ["editorial_state"] } }, { status: 409 }));
    expect(unmet).toEqual({ status: 409, body: { code: "listing_conditions_unmet", details: { failed: ["editorial_state"] } } });
    const sensitive = await call(`materials/${material}/listing`, "POST", listing, rights, () => Response.json({ code: "validation_failed", details: { fields: ["/state"] } }, { status: 422 }));
    expect(sensitive).toEqual({ status: 422, body: { code: "listing_sensitive" } });
    const other = await call(`materials/${material}/listing`, "PUT", listing, rights, () => Response.json({ code: "invalid_transition", message: "canary" }, { status: 409 }));
    expect(other).toEqual({ status: 409, body: { code: "request_failed" } });
  });
});

describe("listing conditions and what a license delivers", () => {
  it("the panel lists the four conditions of a listing with their state before any attempt", () => {
    const html = renderToStaticMarkup(<ListingConditions locale="en" material={{ rights_state: "sellable", editorial_state: "inbox", technical_state: "verified", sensitivity: { minors: true, injured: false, graphic: false } }} />);
    const c = en.listing.conditions;
    for (const name of [c.rights_state, c.editorial_state, c.technical_state, c.sensitivity]) expect(html).toContain(name);
    expect(html.match(/data-met="true"/g)).toHaveLength(2); expect(html.match(/data-met="false"/g)).toHaveLength(2);
  });
  it("the produced cut is never written as delivered, since no package carries it yet", () => {
    expect(delivered(["original", "produced", "stills"])).toEqual(["original", "stills"]);
    expect(en.templates.deliverableNames.original).not.toMatch(/^Original$/); expect(ar.store.browse.deliveryText).not.toContain("الأصل الخام لا يُسلَّم");
  });
});
