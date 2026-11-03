import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { handle } from "../src/server/handler";
import type { Me } from "../src/lib/types";
import type { WebConfig } from "../src/server/config";
import { approvalInput, groupCode, normalizeBackupCode, recoveryStartInput, resetLinkFor, resetLinkInput, safeApproval, safeCodes, safeCodeStatus, safeResetLink } from "../src/lib/recovery-policy";
import { assertionInput, registrationInput, safeChallenge, safePasskeyList, stepUpInput, validCredential } from "../src/lib/passkey-policy";
import { ceremonyFailure } from "../src/lib/passkey-client";
import { notificationKind } from "../src/lib/notification-kind";
import { notificationTarget } from "../src/lib/assignment-policy";
import { safeNotification } from "../src/lib/privacy";
import { tokenFromHash } from "../src/lib/invite-policy";
import { MemoryStore } from "./memory-store";
import { me, tokens } from "./fixtures";

// استعادة الحساب بلا بريد ومفاتيح المرور على الويب (ADR 0107، 0108): المدخلات والقوائم البيضاء والـBFF. قيم اصطناعية منخفضة الإنتروبيا.
const hidden = { rlm: "\u200F", nbsp: "\u00A0" };
const resetToken = "synthetic-reset-token-000000000001", other = "10000000-0000-4000-8000-000000000003", requestId = "70000000-0000-4000-8000-000000000001";
const credential = { id: "c3ludGhldGljLXBhc3NrZXk", rawId: "c3ludGhldGljLXBhc3NrZXk", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "c3ludGhldGlj" }, clientExtensionResults: {} };
const assertion = { id: "c3ludGhldGljLXBhc3NrZXk", rawId: "c3ludGhldGljLXBhc3NrZXk", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "c3ludGhldGlj", signature: "c3ludGhldGlj" }, clientExtensionResults: {} };
const challenge = (extra: Record<string, unknown> = {}) => ({ challenge_id: randomUUID(), public_key: { challenge: "c3ludGhldGljLWNoYWxsZW5nZQ", timeout: 60000 }, expires_at: "2026-11-03T10:05:00Z", ...extra });

describe("recovery without email: inputs and allow-lists", () => {
  it("normalizes a backup code typed with spaces, dashes or lowercase, and refuses anything outside base32", () => {
    expect(normalizeBackupCode("abcd-efgh 2345")).toBe("ABCDEFGH2345");
    for (const bad of ["ABCD1234EFGH", "short", `ABCDEFGH${hidden.rlm}2345`, "A".repeat(65)]) expect(normalizeBackupCode(bad)).toBeNull();
    expect(groupCode("ABCDEFGH2345")).toBe("ABCD-EFGH-2345");
    expect(recoveryStartInput({ email: " someone@example.test ", backup_code: "abcd efgh 2345" })).toEqual({ email: "someone@example.test", backup_code: "ABCDEFGH2345" });
    expect(recoveryStartInput({ email: "not-an-email", backup_code: "ABCDEFGH2345" })).toBeNull();
    expect(recoveryStartInput({ email: "someone@example.test", backup_code: "ABCDEFGH2345", password: "x" })).toBeNull();
  });
  it("takes one closed reason for a reset link, and passes back the token only when it has the contract's shape", () => {
    expect(resetLinkInput({ reason: "lost_device" })).toEqual({ reason: "lost_device" });
    for (const body of [{}, { reason: "other" }, { reason: "lost_device", note: "x" }]) expect(resetLinkInput(body)).toBeNull();
    const link = { recovery_request_id: requestId, reset_token: resetToken, reset_token_expires_at: "2026-11-03T11:00:00Z" };
    expect(safeResetLink({ ...link, canary: "never-display-canary" } as never)).toEqual(link);
    expect(safeResetLink({ ...link, reset_token: "short" })).toEqual({ recovery_request_id: requestId, reset_token_expires_at: link.reset_token_expires_at });
    expect(() => safeResetLink({ ...link, recovery_request_id: "x" })).toThrow();
  });
  it("builds the reset link on the web origin with the token after #, which the reset page reads back", () => {
    const link = resetLinkFor("https://web.example.test", "ar", resetToken);
    expect(link).toBe(`https://web.example.test/ar/reset-password#token=${resetToken}`);
    expect(new URL(link).search).toBe(""); expect(tokenFromHash(new URL(link).hash)).toBe(resetToken);
  });
  it("cleans the verification note, refuses an empty or over-long one, and keeps the approval to its fields", () => {
    expect(approvalInput({ verification_note: `  لقاء في\n المكتب${hidden.rlm} ` })).toEqual({ verification_note: "لقاء في المكتب" });
    for (const body of [{ verification_note: "   " }, { verification_note: "x".repeat(501) }, { verification_note: "ok", extra: 1 }]) expect(approvalInput(body)).toBeNull();
    expect(safeApproval({ id: requestId, state: "approved", created_at: "2026-11-03T10:00:00Z", reset_token: resetToken, reset_token_expires_at: "2026-11-04T10:00:00Z" }))
      .toEqual({ id: requestId, reset_token: resetToken, reset_token_expires_at: "2026-11-04T10:00:00Z" });
    expect(safeApproval({ id: requestId, state: "approved", created_at: "2026-11-03T10:00:00Z" })).toEqual({ id: requestId, reset_token_expires_at: null });
  });
  it("passes ten backup codes of the contract's shape and the remaining count only", () => {
    const codes = Array.from({ length: 10 }, (_, i) => `SYNTHETICOD${"ABCDEFGHJK"[i]}`);
    expect(safeCodes({ codes, generated_at: "2026-11-03T10:00:00Z" })).toEqual({ codes, generated_at: "2026-11-03T10:00:00Z" });
    expect(() => safeCodes({ codes: codes.slice(1), generated_at: "2026-11-03T10:00:00Z" })).toThrow();
    expect(() => safeCodes({ codes: [...codes.slice(1), "lowercase000"], generated_at: "2026-11-03T10:00:00Z" })).toThrow();
    expect(safeCodeStatus({ remaining: 3, generated_at: null, canary: "never-display-canary" } as never)).toEqual({ remaining: 3, generated_at: null });
    expect(() => safeCodeStatus({ remaining: 11, generated_at: null })).toThrow();
  });
  it("opens the approval page from a recovery notification, and names it as an account request", () => {
    const notice = safeNotification({ id: "n", type: "auth.recovery_requested", title: "never-display-canary", material_id: null, recovery_request_id: requestId, priority: "normal", state: "sent", escalation_level: 0, created_at: "2026-11-03T10:00:00Z", read_at: null, acknowledged_at: null });
    expect(notice.recovery_request_id).toBe(requestId); expect(notice.title).toBe("");
    expect(notificationTarget(notice, "en")).toBe(`/en/recovery-requests/${requestId}`);
    expect(notificationKind(notice)).toEqual({ word: "account", icon: "key" });
    expect(safeNotification({ ...notice, recovery_request_id: "../x" }).recovery_request_id).toBeUndefined();
  });
});

describe("passkeys: inputs and allow-lists", () => {
  it("re-checks the password, and a six-digit code when given", () => {
    expect(stepUpInput({ password: "synthetic-password" })).toEqual({ password: "synthetic-password" });
    expect(stepUpInput({ password: "synthetic-password", totp_code: "123456" })).toEqual({ password: "synthetic-password", totp_code: "123456" });
    for (const body of [{}, { password: "short" }, { password: "synthetic-password", totp_code: "12345" }, { password: "synthetic-password", email: "x" }]) expect(stepUpInput(body)).toBeNull();
  });
  it("checks the shape and size of the browser's response and passes it through as it is", () => {
    expect(validCredential(credential)).toBe(true); expect(validCredential(assertion)).toBe(true);
    for (const bad of [null, [], { ...credential, id: "has space" }, { ...credential, response: "x" }, { ...credential, response: { ...credential.response, clientDataJSON: "a".repeat(8193) } }, { ...assertion, response: { ...assertion.response, userHandle: "!" } }])
      expect(validCredential(bad)).toBe(false);
    expect(validCredential({ ...credential, extra: "x".repeat(50000) })).toBe(false);
    expect(registrationInput({ challenge_id: requestId, credential, name: "حاسوب المكتب" })).toEqual({ challenge_id: requestId, credential, name: "حاسوب المكتب" });
    expect(registrationInput({ challenge_id: requestId, credential, name: ` حاسوب` })).toBeNull();
    expect(registrationInput({ challenge_id: requestId, credential, name: "x".repeat(41) })).toBeNull();
    expect(registrationInput({ challenge_id: "x", credential })).toBeNull();
    expect(assertionInput({ challenge_id: requestId, credential: assertion })).toEqual({ challenge_id: requestId, credential: assertion });
    expect(assertionInput({ challenge_id: requestId, credential: assertion, email: "x" })).toBeNull();
  });
  it("passes the WebAuthn options as they are, and a passkey without its credential id", () => {
    const value = challenge();
    expect(safeChallenge({ ...value, canary: "never-display-canary" } as never)).toEqual(value);
    expect(() => safeChallenge({ ...value, public_key: { timeout: 1 } })).toThrow();
    expect(() => safeChallenge({ ...value, public_key: { challenge: "a".repeat(17000) } })).toThrow();
    const list = safePasskeyList({ items: [{ id: requestId, name: `x${hidden.rlm}`, multi_device: true, created_at: "2026-11-03T10:00:00Z", last_used_at: null, credential_id: "c3ludGhldGlj" } as never] });
    expect(list).toEqual({ items: [{ id: requestId, name: null, multi_device: true, created_at: "2026-11-03T10:00:00Z", last_used_at: null }] });
  });
  it("says cancelled for a dismissed prompt, already registered for an excluded key, and failed otherwise", () => {
    expect(ceremonyFailure({ name: "NotAllowedError" })).toBe("cancelled"); expect(ceremonyFailure({ name: "AbortError" })).toBe("cancelled");
    expect(ceremonyFailure({ name: "InvalidStateError" })).toBe("exists"); expect(ceremonyFailure(new Error("x"))).toBe("failed"); expect(ceremonyFailure(null)).toBe("failed");
  });
});

const config: WebConfig = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: "redis://127.0.0.1:6379/1", secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 28800, mediaOrigins: [], tusOrigins: [], trustForwardedFor: false };
const as = (...names: Me["roles"][number]["name"][]): Me => ({ ...me, roles: names.map(name => ({ name, scopes: [] })) });
type Upstream = (request: Request) => Response | Promise<Response>;
async function call(path: string, options: { method?: string; body?: unknown; user?: Me; headers?: Record<string, string>; upstream?: Upstream; session?: boolean } = {}) {
  const store = new MemoryStore(), id = options.session === false ? "" : await store.create(tokens()), calls: Request[] = [], method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(id ? { Cookie: `${config.cookieName}=${id}` } : {}), Origin: config.origin, "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": randomUUID(), ...options.headers };
  for (const [key, value] of Object.entries(headers)) if (value === "") delete headers[key];
  const request = new NextRequest(`${config.origin}/api/bff/${path}`, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(options.body ?? {}) }) });
  const fetch = (async (input: Request) => {
    if (input.url.endsWith("/auth/me")) return Response.json(options.user ?? as("system_admin"));
    calls.push(input); return options.upstream ? options.upstream(input) : new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { result: await handle(request, path, { config, store, fetch }), calls, store, id };
}

describe("BFF: recovery and passkey sign-in without a session", () => {
  it("answers the same 202 for any email and code, sends the normalized code once, and echoes neither", async () => {
    const started = await call("auth/recovery", { method: "POST", session: false, body: { email: "someone@example.test", backup_code: "abcd-efgh-2345" }, upstream: async r => { expect(await r.json()).toEqual({ email: "someone@example.test", backup_code: "ABCDEFGH2345" }); return Response.json({ message: "never-display-canary" }, { status: 202 }); } });
    expect(started.result.status).toBe(202); const text = await started.result.text();
    expect(JSON.parse(text)).toEqual({ ok: true }); expect(text).not.toContain("ABCD"); expect(started.result.headers.get("Cache-Control")).toContain("no-store");
    const bad = await call("auth/recovery", { method: "POST", session: false, body: { email: "someone@example.test", backup_code: "0000" } });
    expect(bad.result.status).toBe(422); expect(bad.calls).toHaveLength(0);
    const limited = await call("auth/recovery", { method: "POST", session: false, body: { email: "someone@example.test", backup_code: "ABCDEFGH2345" }, upstream: () => Response.json({}, { status: 429 }) });
    expect(limited.result.status).toBe(429);
  });
  it("passes the sign-in options as they are, and says when passkeys are off on the server", async () => {
    const value = challenge();
    const options = await call("auth/passkeys/login-options", { method: "POST", session: false, upstream: () => Response.json({ ...value, canary: "never-display-canary" }) });
    expect(options.result.status).toBe(200); expect(await options.result.json()).toEqual(value); expect(options.calls[0].headers.get("authorization")).toBeNull();
    const off = await call("auth/passkeys/login-options", { method: "POST", session: false, upstream: () => Response.json({}, { status: 404 }) });
    expect(off.result.status).toBe(404); expect(await off.result.json()).toEqual({ code: "passkeys_unavailable" });
    expect((await call("auth/passkeys/login-options", { method: "POST", session: false, body: { email: "x" } })).result.status).toBe(422);
  });
  it("signs in with a verified passkey into a new cookie, keeps the tokens on the server, and maps a refused or stale assertion", async () => {
    const body = { challenge_id: requestId, credential: assertion };
    const ok = await call("auth/passkeys/login", { method: "POST", body, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json(tokens()); } });
    expect(ok.result.status).toBe(200); const text = await ok.result.text();
    expect(text).not.toContain("synthetic-access"); expect(JSON.parse(text)).toEqual({ ok: true });
    const cookie = ok.result.cookies.get(config.cookieName)!.value;
    expect(cookie).not.toBe(ok.id); expect(ok.store.data.has(cookie)).toBe(true); expect(ok.store.data.has(ok.id)).toBe(false);
    const refused = await call("auth/passkeys/login", { method: "POST", session: false, body, upstream: () => Response.json({ code: "unauthorized" }, { status: 401 }) });
    expect(refused.result.status).toBe(401); expect(await refused.result.json()).toEqual({ code: "passkey_failed" }); expect(refused.result.cookies.get(config.cookieName)).toBeUndefined();
    const stale = await call("auth/passkeys/login", { method: "POST", session: false, body, upstream: () => Response.json({ code: "challenge_expired" }, { status: 410 }) });
    expect(stale.result.status).toBe(410); expect(await stale.result.json()).toEqual({ code: "challenge_expired" });
    expect((await call("auth/passkeys/login", { method: "POST", session: false, body: { challenge_id: requestId, credential: { id: "x" } } })).result.status).toBe(422);
  });
  it("refuses the public account routes from another origin", async () => {
    const foreign = await call("auth/recovery", { method: "POST", session: false, body: { email: "someone@example.test", backup_code: "ABCDEFGH2345" }, headers: { Origin: "https://other.example.test" } });
    expect(foreign.result.status).toBe(403); expect(foreign.calls).toHaveLength(0);
  });
});

describe("BFF: backup codes, passkeys, reset links and approvals with a session", () => {
  it("reads the remaining count, and generates codes once after a password and code re-check, without a stored key", async () => {
    const status = await call("auth/recovery-codes", { upstream: () => Response.json({ remaining: 7, generated_at: "2026-11-03T10:00:00Z", canary: "never-display-canary" }) });
    expect(await status.result.json()).toEqual({ remaining: 7, generated_at: "2026-11-03T10:00:00Z" });
    const codes = Array.from({ length: 10 }, (_, i) => `SYNTHETICOD${"ABCDEFGHJK"[i]}`), sent: unknown[] = [];
    const fresh = await call("auth/recovery-codes", { method: "POST", body: { password: "synthetic-password", totp_code: "123456" }, upstream: async r => {
      sent.push(await r.json()); return Response.json({ codes, generated_at: "2026-11-03T10:00:00Z", canary: "never-display-canary" });
    } });
    expect(fresh.result.status).toBe(200); expect(await fresh.result.json()).toEqual({ codes, generated_at: "2026-11-03T10:00:00Z" });
    expect(sent).toEqual([{ password: "synthetic-password", totp_code: "123456" }]); expect(fresh.result.headers.get("Cache-Control")).toContain("no-store");
    expect(fresh.calls[0].headers.get("Content-Type")).toContain("application/json");
    // بلا رمز حين لا يكتبه المستخدم (الحساب بلا مصادقة ثنائية): كلمة المرور وحدها
    const passwordOnly = await call("auth/recovery-codes", { method: "POST", body: { password: "synthetic-password" }, upstream: async r => { sent.push(await r.json()); return Response.json({ codes, generated_at: "2026-11-03T10:00:00Z" }); } });
    expect(passwordOnly.result.status).toBe(200); expect(sent[1]).toEqual({ password: "synthetic-password" });
  });
  it("refuses a body without the re-check, or with anything beside it, before the server", async () => {
    for (const body of [{}, { count: 20 }, { password: "short" }, { password: "synthetic-password", totp_code: "12345" }, { password: "synthetic-password", totp_code: 123456 }, { password: "synthetic-password", email: "someone@example.test" }]) {
      const refused = await call("auth/recovery-codes", { method: "POST", body });
      expect(refused.result.status, JSON.stringify(body)).toBe(422); expect(refused.calls).toHaveLength(0);
      expect(await refused.result.json()).toEqual({ code: "request_failed" });
    }
  });
  it("turns a wrong password or missing code before generating into 422 with its code, keeps the session, and passes 429 on", async () => {
    const missing = await call("auth/recovery-codes", { method: "POST", body: { password: "synthetic-password" }, upstream: () => Response.json({ code: "totp_required" }, { status: 401 }) });
    expect(missing.result.status).toBe(422); expect(await missing.result.json()).toEqual({ code: "totp_required" }); expect(missing.store.data.has(missing.id)).toBe(true);
    const wrong = await call("auth/recovery-codes", { method: "POST", body: { password: "wrong-password", totp_code: "000000" }, upstream: () => Response.json({ code: "unauthorized", message: "never-display-canary" }, { status: 401 }) });
    expect(wrong.result.status).toBe(422); const text = await wrong.result.text();
    expect(JSON.parse(text)).toEqual({ code: "step_up_failed" }); expect(text).not.toContain("wrong-password"); expect(wrong.store.data.has(wrong.id)).toBe(true);
    const limited = await call("auth/recovery-codes", { method: "POST", body: { password: "synthetic-password", totp_code: "123456" }, upstream: () => Response.json({ code: "rate_limited" }, { status: 429, headers: { "Retry-After": "4" } }) });
    expect(limited.result.status).toBe(429); expect(limited.store.data.has(limited.id)).toBe(true);
    const malformed = await call("auth/recovery-codes", { method: "POST", body: { password: "synthetic-password" }, upstream: () => Response.json({ codes: ["lowercase000"], generated_at: "2026-11-03T10:00:00Z" }) });
    expect(malformed.result.status).toBe(502);
  });
  it("turns a wrong password or missing code before registering into 422, so the session stays", async () => {
    const wrong = await call("auth/passkeys/registration-options", { method: "POST", body: { password: "synthetic-password" }, upstream: () => Response.json({ code: "totp_required" }, { status: 401 }) });
    expect(wrong.result.status).toBe(422); expect(await wrong.result.json()).toEqual({ code: "totp_required" }); expect(wrong.store.data.has(wrong.id)).toBe(true);
    const bad = await call("auth/passkeys/registration-options", { method: "POST", body: { password: "synthetic-password", totp_code: "000000" }, upstream: () => Response.json({ code: "unauthorized" }, { status: 401 }) });
    expect(await bad.result.json()).toEqual({ code: "step_up_failed" });
    const full = await call("auth/passkeys/registration-options", { method: "POST", body: { password: "synthetic-password", totp_code: "123456" }, upstream: () => Response.json({ code: "passkey_limit_reached" }, { status: 409 }) });
    expect(full.result.status).toBe(409); expect(await full.result.json()).toEqual({ code: "passkey_limit_reached" });
    const value = challenge();
    const ok = await call("auth/passkeys/registration-options", { method: "POST", body: { password: "synthetic-password", totp_code: "123456" }, upstream: () => Response.json(value) });
    expect(await ok.result.json()).toEqual(value);
  });
  it("registers a passkey with the browser's key, maps conflicts, and lists passkeys without credential ids", async () => {
    const key = randomUUID(), body = { challenge_id: requestId, credential, name: "حاسوب المكتب" };
    const passkey = { id: requestId, name: "حاسوب المكتب", multi_device: false, created_at: "2026-11-03T10:00:00Z", last_used_at: null };
    const ok = await call("me/passkeys", { method: "POST", body, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual(body); return Response.json({ ...passkey, credential_id: "c3ludGhldGlj" }, { status: 201 }); } });
    expect(ok.result.status).toBe(201); expect(await ok.result.json()).toEqual(passkey); expect(ok.calls[0].headers.get("Idempotency-Key")).toBe(key);
    const missing = await call("me/passkeys", { method: "POST", body, headers: { "Idempotency-Key": "" } });
    expect(missing.result.status).toBe(400); expect(missing.calls).toHaveLength(0);
    expect(await (await call("me/passkeys", { method: "POST", body, upstream: () => Response.json({ code: "passkey_exists" }, { status: 409 }) })).result.json()).toEqual({ code: "passkey_exists" });
    expect((await call("me/passkeys", { method: "POST", body, upstream: () => Response.json({ code: "challenge_expired" }, { status: 410 }) })).result.status).toBe(410);
    expect(await (await call("me/passkeys", { method: "POST", body, upstream: () => Response.json({ code: "validation_failed", message: "never-display-canary" }, { status: 422 }) })).result.json()).toEqual({ code: "passkey_rejected" });
    const list = await call("me/passkeys", { upstream: () => Response.json({ items: [{ ...passkey, credential_id: "c3ludGhldGlj" }] }) });
    expect(await list.result.json()).toEqual({ items: [passkey] });
    const off = await call("me/passkeys", { upstream: () => Response.json({}, { status: 404 }) }); expect(await off.result.json()).toEqual({ code: "passkeys_unavailable" });
    const revoke = await call(`me/passkeys/${requestId}`, { method: "DELETE" }); expect(revoke.result.status).toBe(204); expect(revoke.calls[0].method).toBe("DELETE");
    expect((await call("me/passkeys/not-a-uuid", { method: "DELETE" })).result.status).toBe(405);
  });
  it("issues a reset link for the administrator only, never for oneself, and the token passes back once", async () => {
    const link = { recovery_request_id: requestId, reset_token: resetToken, reset_token_expires_at: "2026-11-03T11:00:00Z" };
    const denied = await call(`users/${other}/password-reset-links`, { method: "POST", user: as("supervisor"), body: { reason: "forgot_password" } });
    expect(denied.result.status).toBe(403); expect(denied.calls).toHaveLength(0);
    const self = await call(`users/${me.user_id}/password-reset-links`, { method: "POST", body: { reason: "forgot_password" } });
    expect(self.result.status).toBe(403); expect(self.calls).toHaveLength(0);
    const bad = await call(`users/${other}/password-reset-links`, { method: "POST", body: { reason: "because" } }); expect(bad.result.status).toBe(422); expect(bad.calls).toHaveLength(0);
    const key = randomUUID();
    const ok = await call(`users/${other}/password-reset-links`, { method: "POST", body: { reason: "lost_device" }, headers: { "Idempotency-Key": key }, upstream: async r => { expect(await r.json()).toEqual({ reason: "lost_device" }); return Response.json(link, { status: 201 }); } });
    expect(ok.result.status).toBe(201); expect(await ok.result.json()).toEqual(link); expect(ok.calls[0].headers.get("Idempotency-Key")).toBe(key); expect(ok.result.headers.get("Cache-Control")).toContain("no-store");
    const replay = await call(`users/${other}/password-reset-links`, { method: "POST", body: { reason: "lost_device" }, upstream: () => Response.json({ recovery_request_id: requestId, reset_token_expires_at: link.reset_token_expires_at }, { status: 201 }) });
    expect(await replay.result.json()).not.toHaveProperty("reset_token");
    const quorum = await call(`users/${other}/password-reset-links`, { method: "POST", body: { reason: "lost_device" }, upstream: () => Response.json({ code: "admin_quorum_required" }, { status: 403 }) });
    expect(await quorum.result.json()).toEqual({ code: "admin_quorum_required" });
    expect((await call(`users/${other}/password-reset-links`, { method: "POST", body: { reason: "lost_device" }, upstream: () => Response.json({ code: "recovery_state_conflict" }, { status: 409 }) })).result.status).toBe(409);
  });
  it("approves a recovery request for a supervisor or administrator with a cleaned note, without a stored key", async () => {
    const reporter = await call(`auth/recovery/${requestId}/approve`, { method: "POST", user: as("reporter"), body: { verification_note: "لقاء في المكتب" } });
    expect(reporter.result.status).toBe(403); expect(reporter.calls).toHaveLength(0);
    const ok = await call(`auth/recovery/${requestId}/approve`, { method: "POST", user: as("supervisor"), body: { verification_note: " لقاء في  المكتب " }, upstream: async r => {
      expect(await r.json()).toEqual({ verification_note: "لقاء في المكتب" });
      return Response.json({ id: requestId, state: "approved", created_at: "2026-11-03T10:00:00Z", reset_token: resetToken, reset_token_expires_at: "2026-11-04T10:00:00Z" });
    } });
    expect(ok.result.status).toBe(200); expect(await ok.result.json()).toEqual({ id: requestId, reset_token: resetToken, reset_token_expires_at: "2026-11-04T10:00:00Z" });
    const again = await call(`auth/recovery/${requestId}/approve`, { method: "POST", user: as("supervisor"), body: { verification_note: "لقاء" }, upstream: () => Response.json({ code: "recovery_state_conflict" }, { status: 409 }) });
    expect(again.result.status).toBe(409);
    expect((await call(`auth/recovery/${requestId}/approve`, { method: "POST", user: as("supervisor"), body: { verification_note: "" } })).result.status).toBe(422);
  });
});
