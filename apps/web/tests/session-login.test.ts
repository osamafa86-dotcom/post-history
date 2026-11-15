import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { handle } from "../src/server/handler";
import type { WebConfig } from "../src/server/config";
import { safeMe } from "../src/lib/privacy";
import { returnPath, loginTarget } from "../src/lib/return-path";
import { loginFailure, loginFailureText } from "../src/lib/login-policy";
import { untilVisible } from "../src/lib/visibility";
import { userLine } from "../src/components/workspace-nav";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
function request(path: string, id?: string, body?: unknown) {
  return new NextRequest(`${config.origin}/api/bff/${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(id ? { Cookie: `${config.cookieName}=${id}` } : {}), Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const transport = (fn: (request: Request) => Response | Promise<Response>): typeof fetch => (async input => fn(input as Request)) as typeof fetch;
const login = (answer: () => Response) => handle(request("auth/login", undefined, { email: me.email, password: "synthetic-password" }), "auth/login", { config, store: new MemoryStore(), fetch: transport(answer) });

describe("sign-in answers that are not about the credentials", () => {
  it("passes the throttle and its wait to the browser, and nothing else of the upstream answer", async () => {
    const result = await login(() => new Response(JSON.stringify({ code: "rate_limited", message: "protected value" }), { status: 429, headers: { "Retry-After": "37", "Content-Type": "application/json" } }));
    expect(result.status).toBe(429); expect(result.headers.get("retry-after")).toBe("37");
    expect(await result.json()).toEqual({ code: "too_many_attempts", details: { retry_after_seconds: 37 } });
  });
  it("drops a wait it cannot read rather than showing it", async () => {
    for (const header of [undefined, "soon", "-5", "0", "1.5", "999999999"]) {
      const result = await login(() => new Response("{}", { status: 429, headers: { ...(header ? { "Retry-After": header } : {}), "Content-Type": "application/json" } }));
      expect(result.status).toBe(429); expect(result.headers.get("retry-after")).toBeNull();
      expect(await result.json()).toEqual({ code: "too_many_attempts" });
    }
  });
  it("answers an unreachable or failing server as unavailable, not as wrong credentials", async () => {
    const down = await login(() => { throw new TypeError("fetch failed"); }), broken = await login(() => Response.json({ code: "internal" }, { status: 500 }));
    expect(down.status).toBe(503); expect(await down.json()).toEqual({ code: "temporarily_unavailable" });
    expect(broken.status).toBe(503); expect(await broken.json()).toEqual({ code: "request_failed" });
  });
  it("names the reason in the visitor's language", () => {
    expect(loginFailure(401, { code: "login_failed" })).toEqual({ kind: "credentials" });
    expect(loginFailure(401, { code: "totp_required" })).toEqual({ kind: "totp" });
    expect(loginFailure(429, { code: "too_many_attempts", details: { retry_after_seconds: 37 } })).toEqual({ kind: "throttled", seconds: 37 });
    expect(loginFailure(429, { code: "too_many_attempts" })).toEqual({ kind: "throttled", seconds: null });
    expect(loginFailure(429, { details: { retry_after_seconds: "37" } })).toEqual({ kind: "throttled", seconds: null });
    for (const status of [500, 502, 503, 504]) expect(loginFailure(status, {})).toEqual({ kind: "unavailable" });
    expect(loginFailure(422, {})).toEqual({ kind: "credentials" });
    expect(loginFailureText({ kind: "credentials" }, "ar")).toBe(ar.loginFailed);
    expect(loginFailureText({ kind: "totp" }, "ar")).toBe(ar.totpRequired);
    expect(loginFailureText({ kind: "unavailable" }, "ar")).toBe(ar.loginUnavailable);
    expect(loginFailureText({ kind: "throttled", seconds: null }, "en")).toBe(en.loginThrottledSoon);
    // الثواني حتى دقيقة ونصف، ثم الدقائق مقرّبة إلى أعلى؛ بصيغة الجمع في اللغة
    expect(loginFailureText({ kind: "throttled", seconds: 37 }, "ar")).toBe(ar.loginThrottled.replace("{wait}", "37 ثانية"));
    expect(loginFailureText({ kind: "throttled", seconds: 2 }, "ar")).toBe(ar.loginThrottled.replace("{wait}", "ثانيتين"));
    expect(loginFailureText({ kind: "throttled", seconds: 1 }, "en")).toBe(en.loginThrottled.replace("{wait}", "1 second"));
    expect(loginFailureText({ kind: "throttled", seconds: 840 }, "ar")).toBe(ar.loginThrottled.replace("{wait}", "14 دقيقة"));
    expect(loginFailureText({ kind: "throttled", seconds: 121 }, "en")).toBe(en.loginThrottled.replace("{wait}", "3 minutes"));
    expect(ar.loginThrottled).toContain("{wait}"); expect(en.loginThrottled).toContain("{wait}");
  });
});

describe("a visitor with no session, and a session that ended", () => {
  it("tells them apart: no cookie is signed out, a cookie the store no longer knows is revoked and cleared", async () => {
    const fetch = transport(() => Response.json(me)), store = new MemoryStore();
    const none = await handle(request("auth/me"), "auth/me", { config, store, fetch });
    expect(none.status).toBe(401); expect(await none.json()).toEqual({ code: "signed_out" }); expect(none.headers.get("set-cookie")).toBeNull();
    for (const id of ["a".repeat(64), "not-a-session-id"]) {
      const ended = await handle(request("auth/me", id), "auth/me", { config, store, fetch });
      expect(ended.status).toBe(401); expect(await ended.json()).toEqual({ code: "session_revoked" }); expect(ended.headers.get("set-cookie")).toContain("Max-Age=0");
    }
    const live = await handle(request("auth/me", await store.create(tokens())), "auth/me", { config, store, fetch });
    expect(live.status).toBe(200);
  });
});

describe("the page to return to after signing in", () => {
  const origin = "https://web.example.test", id = "20000000-0000-4000-8000-000000000001";
  it("is a page of this application and nothing else", () => {
    for (const path of ["/ar/inbox", "/en/board?display=1", `/ar/materials/${id}`, `/en/tasks/${id}`, `/ar/store/orders/${id}/invoice`, `/ar/recovery-requests/${id}`, "/ar/store/cart", "/en/notification-rules", "/ar/security"]) expect(returnPath(path, origin)).toBe(path);
    // العائد من صفحة الدفع بجلسة منتهية يرى نتيجة دفعه بعد الدخول: الاستعلام يعود مع المسار
    expect(returnPath(`/ar/store/orders/${id}?returned=1&outcome=paid`, origin)).toBe(`/ar/store/orders/${id}?returned=1&outcome=paid`);
    expect(loginTarget(`/ar/store/orders/${id}?returned=1&outcome=paid`, "en", "store")).toBe(`/en/store/orders/${id}?returned=1&outcome=paid`);
    // الجزء بعد # لا يعود، والمسار يُقرأ بعد تسويته
    expect(returnPath("/ar/inbox#x", origin)).toBe("/ar/inbox");
    for (const value of [undefined, null, 7, "", "inbox", "//evil.example.test/ar/inbox", "https://evil.example.test/ar/inbox", "/\\evil.example.test/ar/inbox", "/ar/inbox\\..", "javascript:alert(1)", "/ar/login", "/ar/login?next=/ar/inbox", "/ar/reset-password",
      "/ar/unknown", "/fr/inbox", "/ar", "/ar/", "/ar/inbox/extra", "/ar/materials", "/ar/materials/a/b", "/ar/inbox/../../outside", "/api/bff/auth/me", "/ar/inbox\n", `/ar/inbox?${"q".repeat(600)}`]) expect(returnPath(value, origin), String(value)).toBeNull();
  });
  it("follows the language chosen on the sign-in page, and falls back to the role's home", () => {
    expect(loginTarget(`/ar/materials/${id}`, "en", "inbox")).toBe(`/en/materials/${id}`);
    expect(loginTarget("/en/board?display=1", "en", "inbox")).toBe("/en/board?display=1");
    expect(loginTarget(null, "ar", "payouts")).toBe("/ar/payouts");
    expect(loginTarget(undefined, "en", "store")).toBe("/en/store");
  });
});

describe("what the browser learns about the signed-in account", () => {
  it("carries the work name, the office and the restricted flag, and still no field outside the list", () => {
    const office = "30000000-0000-4000-8000-000000000001", staff = { ...me, roles: [{ name: "supervisor", scopes: [] }] };
    const full = safeMe({ ...staff, work_name: "محررة المناوبة", office_id: office, credential_reset_required: true, legal_name: "never" } as never) as Record<string, unknown>;
    expect(full.work_name).toBe("محررة المناوبة"); expect(full.office_id).toBe(office); expect(full.credential_reset_required).toBe(true); expect(full).not.toHaveProperty("legal_name");
    const plain = safeMe({ ...staff, work_name: " padded ", office_id: "not-an-id", credential_reset_required: "yes" } as never) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("work_name"); expect(plain).not.toHaveProperty("office_id"); expect(plain).not.toHaveProperty("credential_reset_required");
    expect(userLine(safeMe({ ...staff, work_name: "محررة المناوبة" } as never), "ar")).toBe(`محررة المناوبة · ${ar.topbar.roles.supervisor}`);
    // اسم العمل للطاقم وحده: حساب المراسل والمشتري لا يحمله
    for (const name of ["reporter", "buyer_admin"]) expect(safeMe({ ...me, roles: [{ name, scopes: [] }], work_name: "اسم داخلي" } as never)).not.toHaveProperty("work_name");
  });
});

describe("polling waits for the tab to be visible", () => {
  type Listener = () => void;
  function fakeDocument(state: "visible" | "hidden") {
    const listeners = new Set<Listener>();
    const doc = { visibilityState: state, addEventListener: (_: string, fn: Listener) => { listeners.add(fn); }, removeEventListener: (_: string, fn: Listener) => { listeners.delete(fn); } };
    vi.stubGlobal("document", doc);
    return { doc, listeners, show: () => { doc.visibilityState = "visible"; for (const fn of [...listeners]) fn(); }, flicker: () => { for (const fn of [...listeners]) fn(); } };
  }
  afterEach(() => vi.unstubAllGlobals());
  const settled = async (promise: Promise<void>) => { let done = false; void promise.then(() => { done = true; }); await new Promise(resolve => setTimeout(resolve, 0)); return done; };

  it("continues at once in a visible tab and on the server", async () => {
    fakeDocument("visible"); expect(await settled(untilVisible())).toBe(true);
    vi.unstubAllGlobals(); expect(await settled(untilVisible())).toBe(true);
  });
  it("holds while hidden and continues when the tab is shown, leaving no listener behind", async () => {
    const tab = fakeDocument("hidden"), waiting = untilVisible();
    expect(await settled(waiting)).toBe(false); expect(tab.listeners.size).toBe(1);
    tab.flicker(); expect(await settled(waiting)).toBe(false);
    tab.show(); expect(await settled(waiting)).toBe(true); expect(tab.listeners.size).toBe(0);
  });
  it("lets go when its caller is gone", async () => {
    const tab = fakeDocument("hidden"), controller = new AbortController(), waiting = untilVisible(controller.signal);
    expect(await settled(waiting)).toBe(false);
    controller.abort(); expect(await settled(waiting)).toBe(true); expect(tab.listeners.size).toBe(0);
    expect(await settled(untilVisible(controller.signal))).toBe(true);
  });
});
