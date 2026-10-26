#!/usr/bin/env node
// web-invite-conflict (ADR 0025 part 9, #331/#361/#366): the buyer-invite conflict queue from outside. Two existing accounts outside the organization are
// invited by its buyer admin; the answer must not tell them apart from a fresh address (no account-existence oracle), the queue is the system
// admin's alone, and each resolution needs a present TOTP code that cannot be replayed, with the failures counted to a 429 lockout. HTTP only (no page
// of its own is driven here; the admin screen of #372 is judged by its own tests).
// ORDER MATTERS and is part of the design: a valid code is used first, the wrong-code storm comes last, because the lockout (429) is checked before the code
// and refuses even a valid one while it lasts.
//   ACCEPTANCE_API_BASE_URL (…/v1)  ACCEPTANCE_ADMIN_TOKEN (system admin)  ACCEPTANCE_ADMIN_TOTP_SECRET (base32, as in an otpauth link)
//   ACCEPTANCE_BUYER_ADMIN_TOKEN  ACCEPTANCE_ORGANIZATION_ID  ACCEPTANCE_CONFLICT_EMAILS (two ACTIVE accounts outside that organization, comma separated)
//   optional: ACCEPTANCE_CONFLICT_ROLE (buyer_member)  ACCEPTANCE_TOTP_MAX_ATTEMPTS (12: the wrong codes sent while looking for 429; the server's LOGIN_RATE_LIMIT_MAX must be lower than this or the lockout is "not measured", never a pass)
// Always `partial`: one organization, one admin, one run. Nothing secret or revealing goes into the result (no email, token, code or secret).
import { randomUUID } from "node:crypto";
import { banner, newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";
import { canon } from "../lib/live.mjs";
import { envMissing } from "./web-gap-helpers.mjs";
import { safeFailure, totp } from "./web-commerce-helpers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The two invite answers carry the same shape and status: only ids, times and the address itself may differ. */
export function sameInviteShape(a, b) {
  const strip = (o) => { const c = { ...(o ?? {}) }; for (const k of ["id", "user_id", "email", "invited_at", "created_at", "invite_expires_at", "expires_at", "invite_token", "invite_token_expires_at"]) delete c[k]; return c; };
  return a.status === b.status && canon(Object.keys(strip(a.body)).sort()) === canon(Object.keys(strip(b.body)).sort()) && canon(strip(a.body)) === canon(strip(b.body));
}

/** Which keys differ between two invite answers (names only, never values). */
export function shapeDiff(a, b) {
  const ka = Object.keys(a.body ?? {}).sort(), kb = Object.keys(b.body ?? {}).sort();
  return { only_existing: ka.filter((k) => !kb.includes(k)), only_fresh: kb.filter((k) => !ka.includes(k)), values_differ: ka.filter((k) => kb.includes(k) && canon(a.body[k]) !== canon(b.body[k])) };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner({ name: "web-invite-conflict", criterion: "دعوة ببريد حساب قائم لا تُفرَّق عن دعوة ببريد جديد، وتظهر في طابور مدير النظام وحده، وكل حسم يلزمه رمز TOTP حاضر لا يُعاد استعماله، والمحاولات الخاطئة تصل 429" });
  const missing = envMissing(env, ["ACCEPTANCE_API_BASE_URL", "ACCEPTANCE_ADMIN_TOKEN", "ACCEPTANCE_BUYER_ADMIN_TOKEN", "ACCEPTANCE_ORGANIZATION_ID", "ACCEPTANCE_CONFLICT_EMAILS", "ACCEPTANCE_ADMIN_TOTP_SECRET"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const emails = env.ACCEPTANCE_CONFLICT_EMAILS.split(",").map((x) => x.trim()).filter(Boolean);
  if (emails.length < 2) { console.error("ENVIRONMENT: ACCEPTANCE_CONFLICT_EMAILS needs two addresses; nothing measured"); return { code: 2, doc: null }; }
  const base = env.ACCEPTANCE_API_BASE_URL.replace(/\/$/, "");
  const role = env.ACCEPTANCE_CONFLICT_ROLE ?? "buyer_member";
  const maxWrong = Number(env.ACCEPTANCE_TOTP_MAX_ATTEMPTS ?? 12);
  const doc = newResult("web-invite-conflict", { device: { platform: "server", model: env.ACCEPTANCE_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], deferred = [], metrics = {};
  let checks = 0;
  const check = (name, ok, why = "") => { checks++; if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  const call = async (token, method, path, body, key = randomUUID()) => {
    const res = await fetch(`${base}${path}`, { method, headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "idempotency-key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json ?? {}, retryAfter: res.headers.get("retry-after") };
  };
  const secret = env.ACCEPTANCE_ADMIN_TOTP_SECRET;
  const resolve = (id, state, code) => call(env.ACCEPTANCE_ADMIN_TOKEN, "POST", `/buyer-invite-conflicts/${id}/resolve`, code === undefined ? { state } : { state, totp_code: code });
  const nextWindow = async () => { const now = totp(secret); for (let i = 0; i < 70 && totp(secret) === now; i++) await sleep(500); return totp(secret); };
  try {
    // 1. the invite answers: an existing account, a second one and a fresh address look the same
    const invite = (email) => call(env.ACCEPTANCE_BUYER_ADMIN_TOKEN, "POST", `/buyer-organizations/${env.ACCEPTANCE_ORGANIZATION_ID}/members`, { email, role });
    const [a, b] = await Promise.all(emails.slice(0, 2).map(invite));
    const fresh = await invite(`fresh-${randomUUID().slice(0, 8)}@example.test`);
    check("both existing-account invitations are accepted (201)", a.status === 201 && b.status === 201, `${a.status}, ${b.status}`);
    check("an existing account's invite answers exactly like a fresh address (status and shape): no account-existence oracle", fresh.status === 201 && sameInviteShape(a, fresh) && sameInviteShape(b, fresh), `fresh ${fresh.status} ${JSON.stringify(shapeDiff(a, fresh))}`);

    // 2. the queue is the system admin's
    const asBuyer = await call(env.ACCEPTANCE_BUYER_ADMIN_TOKEN, "GET", "/buyer-invite-conflicts");
    check("the buyer admin cannot read the queue (403)", asBuyer.status === 403, `status ${asBuyer.status}`);
    const queue = await call(env.ACCEPTANCE_ADMIN_TOKEN, "GET", "/buyer-invite-conflicts?state=pending&limit=100");
    const items = Array.isArray(queue.body.items) ? queue.body.items : [];
    const mine = emails.slice(0, 2).map((e) => items.find((i) => i.email === e && i.organization_id === env.ACCEPTANCE_ORGANIZATION_ID));
    check("both new conflicts are pending in the system admin's queue", queue.status === 200 && mine.every(Boolean), `status ${queue.status}, found ${mine.filter(Boolean).length} of 2`);
    if (!mine.every(Boolean)) throw new Error("conflicts missing");
    const [A, B] = mine;
    const asBuyerMembers = await call(env.ACCEPTANCE_BUYER_ADMIN_TOKEN, "GET", `/buyer-organizations/${env.ACCEPTANCE_ORGANIZATION_ID}/members`);
    check("the organization sees the stand-ins as ordinary invited members, with no conflict field", asBuyerMembers.status === 200 && !JSON.stringify(asBuyerMembers.body).includes("conflict") && !JSON.stringify(asBuyerMembers.body).includes(A.existing_user_id));

    // 3. each resolution needs a present code; the answers to a missing and to a wrong one differ by design
    const none = await resolve(A.id, "suspended");
    check("a resolution without a TOTP code is refused as invalid (422)", none.status === 422, `status ${none.status}`);
    const wrong = await resolve(A.id, "suspended", "000000");
    check("a wrong code is 401 totp_required", wrong.status === 401 && wrong.body.code === "totp_required", `status ${wrong.status} ${wrong.body.code}`);
    const c1 = totp(secret);
    const ok1 = await resolve(A.id, "suspended", c1);
    check("a valid code suspends the stand-in member: pending -> suspended", ok1.status === 200 && ok1.body.state === "suspended" && ok1.body.resolved_at === null, `status ${ok1.status} ${ok1.body.state}`);
    const replay = await resolve(B.id, "dismissed", c1);
    check("the same code is refused a second time inside its window (401)", replay.status === 401, `status ${replay.status}`);
    const again = await resolve(A.id, "suspended", c1);
    check("a transition the contract does not allow is 409 invalid_transition", again.status === 409 && again.body.code === "invalid_transition", `status ${again.status} ${again.body.code}`);

    // 4. the next window: a refused transition must not burn the code, then a real one uses it
    const c2 = await nextWindow();
    const refused = await resolve(A.id, "suspended", c2);
    const ok2 = await resolve(B.id, "dismissed", c2);
    check("a refused transition does not consume the code: the next conflict resolves with it (200, dismissed)", refused.status === 409 && ok2.status === 200 && ok2.body.state === "dismissed" && typeof ok2.body.resolved_at === "string", `${refused.status}, ${ok2.status} ${ok2.body.state}`);
    const done = await call(env.ACCEPTANCE_ADMIN_TOKEN, "GET", "/buyer-invite-conflicts?state=dismissed&limit=100");
    check("the resolved conflict is listed as dismissed and no longer pending", (done.body.items ?? []).some((i) => i.id === B.id) && !((await call(env.ACCEPTANCE_ADMIN_TOKEN, "GET", "/buyer-invite-conflicts?state=pending&limit=100")).body.items ?? []).some((i) => i.id === B.id));

    // 5. last: the wrong-code storm to the lockout, which refuses even a valid code while it lasts
    const seen = [];
    for (let i = 0; i < maxWrong && !seen.includes(429); i++) seen.push((await resolve(A.id, "dismissed", "000000")).status);
    metrics.wrong_codes_sent = seen.length;
    if (seen.includes(429)) {
      check("repeated wrong codes end in 429", true);
      const locked = await resolve(A.id, "dismissed", await nextWindow().then(() => totp(secret)));
      check("while locked even a valid code is 429, with a Retry-After", locked.status === 429 && Number(locked.retryAfter) > 0, `status ${locked.status}`);
    } else {
      deferred.push(`lockout: ${seen.length} wrong codes did not reach 429 (the server's limit is above ACCEPTANCE_TOTP_MAX_ATTEMPTS)`);
      console.log("DEFERRED lockout not reached");
    }
  } catch (e) {
    fails.push(`aborted: ${safeFailure(e)}`);
  }
  const failed = fails.length > 0;
  Object.assign(metrics, { checks, checks_failed: fails.length, deferred_checks: deferred.length });
  finish(doc, failed ? "fail" : "partial", metrics, failed ? fails.join("؛ ") :
    `طابور تعارض الدعوات من الخارج: دعوتان ببريدَي حسابين قائمين وثالثة ببريد جديد بالجواب نفسه شكلًا وحالةً (لا كشف لوجود حساب)، والطابور لمدير النظام وحده (المشتري 403)، والحسم بلا رمز 422 وبرمز خاطئ 401، والرمز الصالح يوقف (pending ← suspended) ولا يُعاد استعماله داخل نافذته، والانتقال غير المسموح 409 ولا يحرق الرمز، ثم يُغلق التعارض الآخر بالرمز نفسه في نافذته التالية، ثم المحاولات الخاطئة حتى 429 ورفض الرمز الصالح أثناء القفل بـRetry-After.${deferred.length ? ` لم يُقَس: ${deferred.join("؛ ")}.` : ""} جزئية دائمًا: مؤسسة ومدير وتشغيل واحد؛ لا بريد ولا رمز ولا سر في هذه النتيجة.`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "browser" }));
  return { code: failed ? 1 : 0, doc };
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
