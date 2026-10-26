#!/usr/bin/env node
// اختبار قبول عبر BrowserContext.request لمسار API الذي لا يملك صفحة مستقلة: إنشاء تعارض، طابور، TOTP و429.
import { createHmac } from "node:crypto";
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, loadPlaywright, envDoc, checkList, finishAndWrite, EnvironmentError } from "./web-gap-helpers.mjs";

function totp(secret, now = Date.now()) {
  const normalized = secret.replace(/\s+/g, "").toUpperCase(); const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "";
  for (const ch of normalized) { const value = alphabet.indexOf(ch); if (value < 0) throw new Error("invalid TOTP secret"); bits += value.toString(2).padStart(5, "0"); }
  const key = Buffer.alloc(Math.floor(bits.length / 8)); for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Math.floor(now / 30000); const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter)); const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 15; const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000; return String(value).padStart(6, "0");
}
function headers() { return { "content-type": "application/json", "accept": "application/json", "x-requested-with": "post-history-web" }; }
async function json(response) { try { return await response.json(); } catch { return {}; } }

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-invite-conflict", criterion: "تظهر دعوة البريد القائم في طابور التعارض، يلزمها TOTP، المحاولات الخاطئة تصل 429، والرمز الصالح لا يُعاد استعماله" });
  const required = ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_API_BASE_URL", "ACCEPTANCE_ADMIN_TOKEN", "ACCEPTANCE_BUYER_ADMIN_TOKEN", "ACCEPTANCE_ORGANIZATION_ID", "ACCEPTANCE_CONFLICT_EMAILS", "ACCEPTANCE_ADMIN_TOTP_SECRET"];
  const missing = envMissing(env, required); if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const emails = env.ACCEPTANCE_CONFLICT_EMAILS.split(",").map((x) => x.trim()).filter(Boolean); if (emails.length < 2) { console.error("ENVIRONMENT: ACCEPTANCE_CONFLICT_EMAILS must contain two values; nothing measured"); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-invite-conflict"); const { checks, check } = checkList(); let browser;
  try {
    const { chromium } = await loadPlaywright(); browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const context = await browser.newContext(); const buyer = await context.request.newContext({ baseURL: env.ACCEPTANCE_API_BASE_URL, extraHTTPHeaders: { ...headers(), authorization: `Bearer ${env.ACCEPTANCE_BUYER_ADMIN_TOKEN}` } });
    const admin = await context.request.newContext({ baseURL: env.ACCEPTANCE_API_BASE_URL, extraHTTPHeaders: { ...headers(), authorization: `Bearer ${env.ACCEPTANCE_ADMIN_TOKEN}` } });
    const create = async (email) => buyer.post(`/buyer-organizations/${env.ACCEPTANCE_ORGANIZATION_ID}/members`, { headers: { ...headers(), "idempotency-key": crypto.randomUUID() }, data: { email, role: env.ACCEPTANCE_CONFLICT_ROLE ?? "editor" } });
    const created = await Promise.all(emails.slice(0, 2).map(create));
    check("two existing-account invitations are accepted into the conflict flow", created.every((r) => r.status() === 201));
    const queue = await admin.get("/buyer-invite-conflicts");
    if (queue.status() === 404) throw new Error("the API does not expose the conflict queue");
    const queueBody = await json(queue); const items = Array.isArray(queueBody.items) ? queueBody.items : [];
    check("the conflict queue is readable by the system administrator", queue.status() === 200 && items.length >= 2);
    const conflictId = items[0]?.id; if (!conflictId) throw new Error("no conflict id returned by the queue");
    const resolveUrl = `/buyer-invite-conflicts/${conflictId}/resolve`;
    const missingTotp = await admin.post(resolveUrl, { headers: { ...headers(), "idempotency-key": crypto.randomUUID() }, data: { state: "dismissed" } });
    check("resolution without TOTP is rejected", missingTotp.status() === 401);
    const wrongStatuses = [];
    for (let i = 0; i < Number(env.ACCEPTANCE_TOTP_MAX_ATTEMPTS ?? 6); i++) {
      const response = await admin.post(resolveUrl, { headers: { ...headers(), "idempotency-key": crypto.randomUUID() }, data: { state: "dismissed", totp_code: "000000" } }); wrongStatuses.push(response.status()); if (response.status() === 429) break;
    }
    check("repeated wrong TOTP attempts are rate limited with 429", wrongStatuses.includes(429), wrongStatuses.join(","));
    const code = totp(env.ACCEPTANCE_ADMIN_TOTP_SECRET); const valid = await admin.post(resolveUrl, { headers: { ...headers(), "idempotency-key": crypto.randomUUID() }, data: { state: "dismissed", totp_code: code } });
    check("a valid TOTP resolves the oldest conflict", valid.status() === 200);
    const secondId = items.find((item) => item.id !== conflictId)?.id; if (!secondId) throw new Error("second conflict id was not returned");
    const reused = await admin.post(`/buyer-invite-conflicts/${secondId}/resolve`, { headers: { ...headers(), "idempotency-key": crypto.randomUUID() }, data: { state: "dismissed", totp_code: code } });
    check("reusing the valid TOTP code is rejected", reused.status() === 401 || reused.status() === 429, String(reused.status()));
    const failures = checks.filter((x) => !x.ok); finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "pass", { checks: checks.length, checks_failed: failures.length, conflicts_created: created.filter((r) => r.status() === 201).length, queue_status: queue.status(), missing_totp_status: missingTotp.status(), wrong_totp_rate_limited: wrongStatuses.includes(429), valid_resolution_status: valid.status(), reused_totp_rejected: reused.status() === 401 || reused.status() === 429 }, failures.length ? failures.map((x) => x.name).join("؛ ") : "طلبات API أُرسلت من BrowserContext؛ رموز TOTP والقيم من متغيرات البيئة؛ لا تُكتب الرموز أو الحسابات في النتيجة");
    return { code: failures.length ? 1 : 0, doc };
  } catch (error) { if (error instanceof EnvironmentError) return { code: 2, doc: null }; finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${error.message}`); return { code: 1, doc }; }
  finally { await browser?.close(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
