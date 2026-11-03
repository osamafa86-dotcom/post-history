#!/usr/bin/env node
// account-recovery (ADR 0107): password recovery without an email provider, and passkeys, end to end on a live server.
// No row of the plan's acceptance table: its source is the coordinator's decision (ADR 0107), beside the SEC-01 tests.
//   1. A system admin issues a one-time reset link: the token comes back once (a replay with the same Idempotency-Key answers
//      without it), the account's sessions stop at once, and the link completes through /auth/recovery/complete and
//      /auth/totp/confirm exactly once.
//   2. The account generates ten backup codes; one of them opens a recovery request and is spent.
//   3. With ACCT_ORIGIN and passkeys on: a passkey is registered after the password and TOTP re-check, signs in without a password,
//      and no longer signs in once revoked. A software authenticator (lib/webauthn-soft.mjs), not a browser.
//   4. The events carry ids and counts only, and no token, code, challenge or credential id of the run is in any of them or, when
//      the live runner hands the server log over (setLogSource), in the log.
// Always `partial`: synthetic accounts, one run, a software authenticator; real browsers and security keys are measured in ADR 0108.
//   ACCT_API_URL=http://127.0.0.1:13000/v1
//   ACCT_TOKENS='{"system_admin":"…","target":"…"}'   ACCT_TARGET='{"id":"…","email":"…"}'   (target: a throwaway account the run resets)
//   [ACCT_ORIGIN=http://localhost:3000]   the WebAuthn origin the server allows (WEBAUTHN_ORIGINS); without it the passkey part is not measured
import { randomBytes, randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, eventsOfType } from "../lib/live.mjs";
import { freshFetch } from "../lib/http.mjs";
import { totp } from "../lib/totp.mjs";
import { SoftAuthenticator } from "../lib/webauthn-soft.mjs";

let logSource = null;
/** The live runner hands the server log over; every secret seen in the run must be absent from it. */
export const setLogSource = (fn) => { logSource = fn; };

// the RFC 4648 alphabet: A–Z then 2–7
const BASE32 = String.fromCharCode(...Array.from({ length: 26 }, (_, i) => 65 + i)) + "234567";
/** RFC 4648 base32 (no padding) to hex, the form lib/totp.mjs takes. */
export function base32ToHex(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of text) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out).toString("hex");
}

/** Which of the secrets appear in a text; the secrets themselves are never printed, only how many matched. */
export function leaked(text, secrets) {
  return secrets.filter((s) => typeof s === "string" && s.length >= 8 && text.includes(s)).length;
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("account-recovery"));
  const need = ["ACCT_API_URL", "ACCT_TOKENS", "ACCT_TARGET"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.ACCT_TOKENS), target = JSON.parse(env.ACCT_TARGET);
  if (!tokens.system_admin || !tokens.target || !target.id) { console.error("ENVIRONMENT: ACCT_TOKENS needs system_admin and target, ACCT_TARGET an id; nothing measured"); return { code: 2, doc: null }; }
  const http = client(env.ACCT_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("account-recovery", { device: { platform: "server", model: env.ACCT_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], notMeasured = [], secrets = [], metrics = {};
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  const skip = (name, why) => { notMeasured.push(`${name}: ${why}`); console.log(`NOT MEASURED ${name} — ${why}`); };
  const admin = tokens.system_admin;

  // ---------- 1. the admin's reset link ----------
  const key = randomUUID();
  const issue = () => http.call(admin, "POST", `/users/${target.id}/password-reset-links`, { body: { reason: "forgot_password" }, key });
  const issued = await issue();
  const token = issued.body?.reset_token;
  if (typeof token === "string") secrets.push(token);
  const ttlS = (Date.parse(issued.body?.reset_token_expires_at) - Date.now()) / 1000;
  metrics.reset_link_ttl_s = Number.isFinite(ttlS) ? Math.round(ttlS) : undefined;
  check("the admin issues a reset link once (201 with the token, lifetime under 24 hours)", issued.status === 201 && typeof token === "string" && ttlS > 0 && ttlS <= 86_400, `status ${issued.status}`);
  const replay = await issue();
  check("a replay with the same Idempotency-Key answers the same request without the token", replay.status === 201 && replay.body?.recovery_request_id === issued.body?.recovery_request_id && !("reset_token" in (replay.body ?? {})), `status ${replay.status}`);
  check("the account's existing session stops at once", (await http.get(tokens.target, "/auth/me")).status === 401);

  const password = randomBytes(18).toString("base64url");
  const complete = () => http.call(null, "POST", "/auth/recovery/complete", { body: { reset_token: token, new_password: password }, key: null });
  const done = await complete();
  const secretB32 = done.body?.totp_enrollment?.secret_base32;
  if (typeof secretB32 === "string") secrets.push(secretB32);
  check("the link completes once: a new password and a new TOTP enrolment behind a restricted session", done.status === 200 && typeof secretB32 === "string", `status ${done.status}`);
  check("the same link a second time is 401", (await complete()).status === 401);
  const secretHex = typeof secretB32 === "string" ? base32ToHex(secretB32) : null;
  const confirm = secretHex
    ? await http.call(done.body.session.access_token, "POST", "/auth/totp/confirm", { body: { totp_code: totp(secretHex) }, key: null })
    : { status: 0 };
  const full = confirm.body?.access_token;
  check("confirming the new TOTP gives a full session", confirm.status === 200 && typeof full === "string", `status ${confirm.status}`);

  // ---------- 2. backup codes ----------
  const gen = full ? await http.call(full, "POST", "/auth/recovery-codes", { key: null }) : { status: 0 };
  const codes = Array.isArray(gen.body?.codes) ? gen.body.codes : [];
  secrets.push(...codes);
  check("ten backup codes are shown once", gen.status === 200 && codes.length === 10 && codes.every((c) => /^[A-Z2-7]{12}$/.test(c)), `status ${gen.status}`);
  const remaining = async () => (full ? (await http.get(full, "/auth/recovery-codes")).body?.remaining : undefined);
  check("the status counts ten unused codes and returns none of them", (await remaining()) === 10);
  if (codes[0] && target.email) {
    const started = await http.call(null, "POST", "/auth/recovery", { body: { email: target.email, backup_code: codes[0] }, key: null });
    check("a backup code opens a recovery request (202) and is spent", started.status === 202 && (await remaining()) === 9, `status ${started.status}`);
  } else skip("backup code use", "ACCT_TARGET has no email");

  // ---------- 3. passkeys ----------
  let passkeyEvents = [];
  if (!env.ACCT_ORIGIN) skip("passkeys", "ACCT_ORIGIN is not set");
  else if (!full || !secretHex) skip("passkeys", "no full session after the reset");
  else {
    const device = new SoftAuthenticator(env.ACCT_ORIGIN);
    const options = await http.call(full, "POST", "/auth/passkeys/registration-options", { body: { password, totp_code: totp(secretHex) }, key: null });
    if (options.status === 404) skip("passkeys", "passkeys are off on this server (no WEBAUTHN_RP_ID)");
    else {
      const challenge = options.body?.public_key?.challenge;
      if (typeof challenge === "string") secrets.push(challenge);
      check("registration options after the password and TOTP re-check", options.status === 200 && typeof challenge === "string", `status ${options.status}`);
      const wrong = await http.call(full, "POST", "/auth/passkeys/registration-options", { body: { password: `${password}x` }, key: null });
      check("a wrong password gets no registration options (401)", wrong.status === 401, `status ${wrong.status}`);
      const created = device.create(options.body.public_key);
      secrets.push(created.json.id);
      const registered = await http.call(full, "POST", "/me/passkeys", { body: { challenge_id: options.body.challenge_id, credential: created.json } });
      check("the passkey is registered (201) without its credential id in the answer", registered.status === 201 && !JSON.stringify(registered.body ?? {}).includes(created.json.id), `status ${registered.status}`);
      const signIn = async () => {
        const lo = await http.call(null, "POST", "/auth/passkeys/login-options", { key: null });
        if (typeof lo.body?.public_key?.challenge === "string") secrets.push(lo.body.public_key.challenge);
        return http.call(null, "POST", "/auth/passkeys/login", { body: { challenge_id: lo.body?.challenge_id, credential: device.get(created.credential, lo.body?.public_key ?? {}) }, key: null });
      };
      const signedIn = await signIn();
      check("the passkey signs in without a password or TOTP", signedIn.status === 200 && signedIn.body?.user_id === target.id, `status ${signedIn.status}`);
      const revoked = registered.body?.id ? await http.call(full, "DELETE", `/me/passkeys/${registered.body.id}`) : { status: 0 };
      check("the owner revokes it (204)", revoked.status === 204, `status ${revoked.status}`);
      check("a revoked passkey no longer signs in (401)", (await signIn()).status === 401);
      passkeyEvents = [...(await eventsOfType(http, admin, "auth.passkey_added")), ...(await eventsOfType(http, admin, "auth.passkey_revoked"))]
        .filter((e) => e.aggregate_id === target.id);
      check("passkey events carry the internal id alone", passkeyEvents.length >= 2 && passkeyEvents.every((e) => Object.keys(e.payload).join() === "passkey_id"), `${passkeyEvents.length} events`);
    }
  }

  // ---------- 4. events and logs ----------
  const approved = (await eventsOfType(http, admin, "auth.recovery_approved")).filter((e) => e.payload?.recovery_request_id === issued.body?.recovery_request_id);
  check("the reset link's event carries ids only", approved.length === 1 && Object.keys(approved[0].payload).every((k) => ["recovery_request_id", "office_id"].includes(k)), `${approved.length} events`);
  const generated = (await eventsOfType(http, admin, "auth.recovery_codes_generated")).filter((e) => e.aggregate_id === target.id);
  check("the backup-code event carries the count alone", generated.length >= 1 && generated.every((e) => Object.keys(e.payload).join() === "codes_count"), `${generated.length} events`);
  metrics.secrets_tracked = secrets.length;
  check("no token, code, challenge or credential id of the run is in any event", leaked(JSON.stringify([...approved, ...generated, ...passkeyEvents]), secrets) === 0);
  if (logSource) check("... nor in the server log", leaked(logSource(), secrets) === 0);
  else skip("server log", "the log is not handed over (run through live/run.mjs)");

  const failed = fails.length > 0;
  finish(doc, failed ? "fail" : "partial", { variant: "reset-link-codes-passkey", ...metrics, failures: fails.length },
    ["حسابات اصطناعية وتشغيل واحد ومصادِق برمجي (ES256 بشهادة none) لا متصفح؛ المتصفحات الحقيقية ومفاتيح الأمان في ADR 0108",
     notMeasured.length ? `لم يُقَس: ${notMeasured.join("؛ ")}` : null].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "local" }));
  return { code: failed ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
