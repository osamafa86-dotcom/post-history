import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { safeOrganization, seatsOf, type Organization } from "../src/lib/buyer-policy";
import { countryCodes, countryName, countryOptions, isCountry } from "../src/lib/countries";
import { TotpNeeded } from "../src/components/invite-conflicts";
import { OrgPending } from "../src/components/store/org-pending";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const org = "90000000-0000-4000-8000-000000000001", other = "90000000-0000-4000-8000-000000000002", member = "91000000-0000-4000-8000-000000000001";
const admin: Me = { ...me, roles: [{ name: "system_admin", scopes: [] }] };
const buyerAdmin: Me = { ...me, organization_id: org, roles: [{ name: "buyer_admin", scopes: [] }] }, buyerMember: Me = { ...buyerAdmin, roles: [{ name: "buyer_member", scopes: [] }] };
const invitedRow = { user_id: member, email: "desk@example.test", role: "buyer_member", status: "invited", totp_enabled: false, created_at: "2026-10-22T10:00:00Z" };
const stored: Organization = { id: org, legal_name: "شركة الأخبار المحدودة", display_name: { ar: "شبكة الأخبار", en: "News Network" }, country: "QA", billing_email: "billing@example.test", seats: 5, status: "active", active_members: 2, verified_at: "2026-10-22T10:00:00Z", created_at: "2026-10-21T10:00:00Z", updated_at: "2026-10-22T10:00:00Z" };

async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: (r: Request) => Response | Promise<Response> } = {}) {
  const store = new MemoryStore(), session = await store.create(tokens()), calls: Request[] = [], method = options.method ?? "POST";
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers: { Cookie: `${config.cookieName}=${session}`, Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers }, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (r: Request) => { if (r.url.endsWith("/auth/me")) return Response.json(options.user ?? admin); calls.push(r); return options.upstream ? options.upstream(r) : new Response(null, { status: 204 }); }) as typeof globalThis.fetch;
  return { result: await handle(request, path.split("?")[0], { config, store, fetch }), calls };
}

describe("member invitation through the BFF", () => {
  const path = `buyer-organizations/${org}/members/${member}/invitation`;
  it("reissues the code for member managers: the new code passes once, nothing else does", async () => {
    const reissued = await call(path, { user: buyerAdmin, body: {}, upstream: () => Response.json({ ...invitedRow, invite_token: "n".repeat(43), invite_token_expires_at: "2026-10-27T10:00:00Z", password_hash: "canary" }) });
    expect(reissued.result.status).toBe(200);
    expect(reissued.calls[0].method).toBe("POST"); expect(new URL(reissued.calls[0].url).pathname).toBe(`/v1/${path}`); expect(reissued.calls[0].headers.get("Idempotency-Key")).toBeTruthy();
    const body = await reissued.result.json();
    expect(body).toMatchObject({ user_id: member, status: "invited", invite_token: "n".repeat(43) }); expect(JSON.stringify(body)).not.toContain("canary");
    expect(reissued.result.headers.get("Cache-Control")).toContain("no-store");
    expect((await call(path, { user: admin, body: {}, upstream: () => Response.json(invitedRow) })).result.status).toBe(200);
  });
  it("cancels with DELETE and answers 204", async () => {
    const cancelled = await call(path, { method: "DELETE", user: buyerAdmin, upstream: () => new Response(null, { status: 204 }) });
    expect(cancelled.result.status).toBe(204); expect(cancelled.calls[0].method).toBe("DELETE"); expect(new URL(cancelled.calls[0].url).pathname).toBe(`/v1/${path}`);
  });
  it("keeps members, other organizations, bodies and other methods out without asking the API", async () => {
    for (const [options, status] of [
      [{ user: buyerMember, body: {} }, 403],
      [{ user: buyerAdmin, body: { role: "buyer_admin" } }, 422],
      [{ method: "PUT", user: buyerAdmin, body: {} }, 405],
    ] as const) { const { result, calls } = await call(path, options); expect(result.status, JSON.stringify(options)).toBe(status); expect(calls).toHaveLength(0); }
    const foreign = await call(`buyer-organizations/${other}/members/${member}/invitation`, { user: buyerAdmin, body: {} });
    expect(foreign.result.status).toBe(404); expect(foreign.calls).toHaveLength(0);
    const malformed = await call(`buyer-organizations/${org}/members/not-a-uuid/invitation`, { user: buyerAdmin, body: {} });
    expect(malformed.result.status).toBe(404); expect(malformed.calls).toHaveLength(0);
  });
  it("names the last-admin refusal and keeps any other 409 generic, never with the server's message", async () => {
    const last = await call(path, { method: "DELETE", user: admin, upstream: () => Response.json({ code: "last_buyer_admin", message: "canary" }, { status: 409 }) });
    expect(last.result.status).toBe(409); expect(await last.result.json()).toEqual({ code: "last_buyer_admin" });
    const accepted = await call(path, { user: buyerAdmin, body: {}, upstream: () => Response.json({ code: "invalid_transition", message: "canary", details: { from: "active" } }, { status: 409 }) });
    expect(accepted.result.status).toBe(409); expect(await accepted.result.json()).toEqual({ code: "request_failed" });
  });
});

describe("seats counter", () => {
  it("adds the invited to the active, and falls back to the active alone when the server sends no split", () => {
    expect(seatsOf({ seats: 8, active_members: 2, invited_members: 3 })).toEqual({ used: 5, active: 2, invited: 3, seats: 8 });
    expect(seatsOf({ seats: 8, active_members: 2 })).toEqual({ used: 2, active: 2, invited: null, seats: 8 });
  });
  it("passes the invited count to the browser only as a count", () => {
    expect(safeOrganization({ ...stored, invited_members: 3 })).toMatchObject({ active_members: 2, invited_members: 3 });
    expect(safeOrganization({ ...stored, invited_members: "3" as unknown as number })).not.toHaveProperty("invited_members");
    expect(safeOrganization(stored)).not.toHaveProperty("invited_members");
  });
  it("the pending-organization panel counts occupied seats, not the active alone", () => {
    const html = renderToStaticMarkup(<OrgPending locale="ar" organization={{ status: "pending_verification", seats: 8, active_members: 2, invited_members: 6 }} canInvite />);
    expect(html).toContain(ar.store.org.nowSeats.replace("{used}", "8").replace("{seats}", "8"));
  });
});

describe("countries", () => {
  it("offers the assigned ISO codes by name in the interface language, sorted by name", () => {
    expect(countryCodes).toHaveLength(249); expect(new Set(countryCodes).size).toBe(249);
    expect(countryName("JO", "en")).toBe("Jordan"); expect(countryName("JO", "ar")).toBe("الأردن");
    const names = countryOptions("en").map(c => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en"))); expect(names).toContain("Qatar");
    expect(countryOptions("ar").every(c => c.name !== c.code)).toBe(true);
  });
  it("keeps an unassigned stored code as it is and never offers it", () => {
    expect(isCountry("ZZ")).toBe(false); expect(isCountry("qa")).toBe(false); expect(isCountry("QA")).toBe(true);
    expect(countryName("ZZ", "ar")).toBe("ZZ"); expect(countryName(null, "ar")).toBe("");
  });
});

describe("resolving an invite conflict without two-step verification", () => {
  it("says to enable it first and where, in both languages", () => {
    for (const [locale, t] of [["ar", ar.conflicts], ["en", en.conflicts]] as const) {
      const html = renderToStaticMarkup(<TotpNeeded locale={locale} />);
      expect(html).toContain(t.totpNeeded); expect(html).toContain(`href="/${locale}/forgot-password"`); expect(html).toContain(t.totpStart);
    }
    expect(ar.conflicts.confirms).toEqual({ suspended: "أوقف", dismissed: "أغلق نهائيًا" });
  });
});
