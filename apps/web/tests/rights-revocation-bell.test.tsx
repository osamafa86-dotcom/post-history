import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { handle } from "../src/server/handler";
import type { Me, Notification } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { safeNotification, storeReference } from "../src/lib/privacy";
import { safeActiveLicenses } from "../src/lib/issued-licenses";
import { RevocationNotice } from "../src/components/transition-dialog";
import { buyerNotice } from "../src/components/notifications-panel";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const material = "20000000-0000-4000-8000-000000000001", org = "90000000-0000-4000-8000-000000000001";
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] }, as = (name: Me["roles"][number]["name"]): Me => ({ ...me, roles: [{ name, scopes: [] }] });
const buyer: Me = { ...me, organization_id: org, roles: [{ name: "buyer_admin", scopes: [] }] };
const notice = (type: string, title: string): Notification => ({ id: randomUUID(), type, title, material_id: null, priority: "normal", state: "sent", created_at: "2026-11-15T10:00:00Z" } as Notification);

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (r: Request) => { if (r.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(r); return options.upstream ? options.upstream(r) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("what leaving «sellable» revokes", () => {
  it("counts through the BFF for the contract's roles only, as two numbers and nothing else", async () => {
    const path = `materials/${material}/active-licenses`;
    for (const user of [as("rights_officer"), as("editor_in_chief"), as("finance"), admin]) {
      const { result, calls } = await call(path, { method: "GET", user, upstream: () => Response.json({ active_licenses: 3, organizations: 2, internal: "canary" }) });
      expect(result.status).toBe(200); expect(await result.json()).toEqual({ active_licenses: 3, organizations: 2 }); expect(new URL(calls[0].url).pathname).toBe(`/v1/${path}`);
    }
    for (const user of [as("supervisor"), as("reporter"), buyer]) { const { result, calls } = await call(path, { method: "GET", user }); expect(result.status).toBe(403); expect(calls).toHaveLength(0); }
    expect((await call("materials/not-a-uuid/active-licenses", { method: "GET", user: admin })).result.status).toBe(404);
    expect((await call(path, { method: "GET", user: admin, upstream: () => Response.json({ active_licenses: -1, organizations: "2" }) })).result.status).toBe(502);
    expect(safeActiveLicenses({ active_licenses: 0, organizations: 0 })).toEqual({ active_licenses: 0, organizations: 0 });
  });
  it("says how many paid licenses and organizations, that it is final, and never stays silent when the count is unknown", () => {
    const some = renderToStaticMarkup(<RevocationNotice locale="ar" counts={{ active_licenses: 2, organizations: 1 }} />);
    expect(some).toContain("سيُبطل بهذا التحويل ترخيصان مدفوعان عند مؤسسة واحدة."); expect(some).toContain(ar.review.revokeFinal); expect(some).toContain('data-state="some"'); expect(some).toContain('role="alert"');
    expect(renderToStaticMarkup(<RevocationNotice locale="ar" counts={{ active_licenses: 11, organizations: 3 }} />)).toContain("11 ترخيصًا مدفوعًا عند 3 مؤسسات");
    expect(renderToStaticMarkup(<RevocationNotice locale="en" counts={{ active_licenses: 1, organizations: 1 }} />)).toContain("This transition will revoke 1 paid license held by 1 organization.");
    expect(renderToStaticMarkup(<RevocationNotice locale="en" counts={{ active_licenses: 3, organizations: 2 }} />)).toContain("3 paid licenses held by 2 organizations");
    const none = renderToStaticMarkup(<RevocationNotice locale="ar" counts={{ active_licenses: 0, organizations: 0 }} />);
    expect(none).toContain(ar.review.revokeNone); expect(none).toContain('data-state="none"'); expect(none).not.toContain(ar.review.revokeFinal);
    const unknown = renderToStaticMarkup(<RevocationNotice locale="ar" counts="unknown" />);
    expect(unknown).toContain(ar.review.revokeUnknown); expect(unknown).toContain('data-state="unknown"');
    expect(renderToStaticMarkup(<RevocationNotice locale="en" counts="loading" />)).toContain(en.review.revokeCounting);
  });
});

describe("licenses revoked for rights and not refunded", () => {
  it("passes the contract's two filters to the API and refuses any other value", async () => {
    const { result, calls } = await call("licenses?status=revoked&revoked_reason=rights_withdrawn&refunded=false&limit=100", { method: "GET", user: as("finance"), upstream: () => Response.json({ items: [], next_cursor: null }) });
    expect(result.status).toBe(200);
    const sent = new URL(calls[0].url).searchParams; expect(Object.fromEntries(sent)).toEqual({ limit: "100", status: "revoked", revoked_reason: "rights_withdrawn", refunded: "false" });
    for (const query of ["revoked_reason=other", "refunded=maybe", "refunded=false&refunded=true"]) { const bad = await call(`licenses?${query}`, { method: "GET", user: as("finance") }); expect(bad.result.status, query).toBe(400); expect(bad.calls).toHaveLength(0); }
  });
});

describe("the buyer's bell", () => {
  it("lets only the license or order number through from the server's title", () => {
    expect(storeReference(notice("license.revoked", "أُبطل الترخيص PH-2026-4HJ8NP0WVZ وتوقف تنزيله canary"))).toBe("PH-2026-4HJ8NP0WVZ");
    expect(safeNotification(notice("order.status_changed", "تغيّرت حالة الطلب ORD-2026-7K3M9Q2X canary")).title).toBe("ORD-2026-7K3M9Q2X");
    expect(safeNotification(notice("license.revoked", "canary without a number")).title).toBe("");
    // رقم في عنوان نوع آخر لا يمرّ، ولا رقم الترخيص في تنبيه طلب
    expect(safeNotification(notice("material.created", "PH-2026-4HJ8NP0WVZ ORD-2026-7K3M9Q2X")).title).toBe("");
    expect(safeNotification(notice("order.status_changed", "PH-2026-4HJ8NP0WVZ")).title).toBe("");
    expect(JSON.stringify(safeNotification(notice("license.revoked", "أُبطل الترخيص PH-2026-4HJ8NP0WVZ canary")))).not.toContain("canary");
  });
  it("words each store event with its number and sends the reader to its page, or to the list when the page is unknown", () => {
    const words = ar.shell.bell.buyer, target = "/ar/store/licenses/93000000-0000-4000-8000-000000000002";
    expect(buyerNotice({ type: "license.revoked", title: "PH-2026-4HJ8NP0WVZ" }, words, "ar", { "PH-2026-4HJ8NP0WVZ": target })).toEqual({ title: "أُبطل الترخيص PH-2026-4HJ8NP0WVZ", text: words.licenseRevokedText, href: target });
    expect(buyerNotice({ type: "license.revoked", title: "" }, words, "ar")).toEqual({ title: words.licenseRevokedPlain, text: words.licenseRevokedText, href: "/ar/store/licenses" });
    expect(buyerNotice({ type: "order.status_changed", title: "ORD-2026-7K3M9Q2X" }, en.shell.bell.buyer, "en")).toEqual({ title: "The status of order ORD-2026-7K3M9Q2X changed", text: en.shell.bell.buyer.orderChangedText, href: "/en/store/orders" });
    expect(buyerNotice({ type: "material.created", title: "" }, words, "ar")).toBeNull();
  });
});
