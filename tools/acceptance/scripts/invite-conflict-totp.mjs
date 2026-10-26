#!/usr/bin/env node
// invite-conflict-totp — حماية حسم تعارض دعوات المشترين برمز TOTP (#366 المدموج، متابعة الأمن #304، العقد #361).
// لا صف مقابل له في جدول «اختبارات القبول» في docs/plan/الخطة-النسخة-الثالثة.md؛ مصدره قرار الأمن لا الخطة،
// ويُقاس على البيئة المحلية فقط:
//   دعوة بريد حساب قائم خارج المؤسسة تُردّ بشكل الدعوة الناجحة (لا تكشف نوع الحساب) وتظهر في طابور المدير،
//   الرمز الصحيح يحسم التعارض مرة واحدة، وإعادة الرمز نفسه على تعارض آخر ← 401 totp_required (لا يُقبل مرتين)،
//   المحاولات الخاطئة المتكررة تتجاوز الحد ← 429 rate_limited بـ Retry-After، وأثناء الحد حتى الرمز الصحيح 429،
//   وبعد كل الفشل يبقى التعارض معلّقًا لم يتغير.
// يُشغَّل على مكدس جديد: عدّاد المحاولات لكل مدير في نافذة الخادم (افتراضيًا 10 في 15 دقيقة) يُستهلك بين التشغيلات
// على النسخة نفسها. النتيجة `partial` دائمًا: مستخدمون اصطناعيون وتشغيل واحد ولا قياس لنافذة انتهاء الحد الزمنية.
//   ICT_API_URL=http://127.0.0.1:13000/v1
//   ICT_TOKENS='{"system_admin":"…","buyer_admin":"…","reporter":"…"}'   (reporter: حساب قائم خارج أي مؤسسة مشترٍ)
//   ICT_TOTP='{"system_admin":"<سر TOTP hex كما تزرعه البذرة>"}'   [ICT_MAX_ATTEMPTS=40]
import { createHmac, randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";

/** رمز TOTP كما يحسبه الخادم (common/crypto.ts): RFC 6238 بـ SHA-1 وست خانات وخطوة 30 ثانية. السر hex كما في البذرة. */
export function totpCode(secretHex, timeMs = Date.now(), step = 30, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)));
  const mac = createHmac("sha1", Buffer.from(secretHex, "hex")).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, "0");
}

/** رمز بست خانات لا يساوي أي رمز مقبول حول الآن (خطوتين قبل وبعد، احتياطًا لعبور حد الخطوة بين الحساب والتحقق). */
export function wrongCode(secretHex, timeMs = Date.now()) {
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => totpCode(secretHex, timeMs + d * 30_000)));
  let candidate = "000000";
  while (valid.has(candidate)) candidate = String(Number(candidate) + 1).padStart(6, "0");
  return candidate;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("invite-conflict-totp"));
  const need = ["ICT_API_URL", "ICT_TOKENS", "ICT_TOTP"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.ICT_TOKENS);
  const missingRoles = ["system_admin", "buyer_admin", "reporter"].filter((r) => !tokens[r]);
  if (missingRoles.length) { console.error(`ENVIRONMENT: ICT_TOKENS needs ${missingRoles.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const secret = JSON.parse(env.ICT_TOTP).system_admin;
  if (typeof secret !== "string" || !/^[0-9a-f]+$/i.test(secret)) { console.error("ENVIRONMENT: ICT_TOTP needs the admin secret as hex; nothing measured"); return { code: 2, doc: null }; }
  const maxAttempts = Number(env.ICT_MAX_ATTEMPTS ?? 40);
  const http = client(env.ICT_API_URL);
  const doc = newResult("invite-conflict-totp", { device: { platform: "server", model: env.ICT_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], deferred = [], metrics = {};
  const check = (name, ok, why = "") => { if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  const defer = (name, why) => { deferred.push(`${name}: ${why}`); console.log(`DEFERRED ${name} — ${why}`); };

  // ---------- تجهيز: حساب قائم خارج المؤسسة، ومؤسستان نشطتان، ودعوتان متعارضتان ----------
  const me = await http.get(tokens.reporter, "/auth/me");
  const existingEmail = me.body?.email;
  check("an existing account outside any buyer organization (the reporter)", me.status === 200 && typeof existingEmail === "string" && !me.body?.organization_id, `status ${me.status}`);
  const admin = await http.get(tokens.system_admin, "/auth/me");
  check("the admin has two-factor enabled", admin.status === 200 && admin.body?.totp_enabled === true, `totp_enabled=${admin.body?.totp_enabled}`);
  const uniq = randomUUID().slice(0, 8);
  const makeOrg = async (label) => {
    const org = await http.call(tokens.system_admin, "POST", "/buyer-organizations", { body: {
      legal_name: `Conflict Buyer ${label} ${uniq}`, display_name: { ar: "مشترٍ", en: "Buyer" }, country: "JO",
      billing_email: `billing-${label}-${uniq}@example.test`, first_admin_email: `admin-${label}-${uniq}@example.test`, seats: 3 } });
    if (org.status !== 201) return { status: org.status };
    const fields = { legal_name: org.body.legal_name, display_name: org.body.display_name, country: org.body.country, billing_email: org.body.billing_email, seats: org.body.seats };
    const act = await http.call(tokens.system_admin, "PUT", `/buyer-organizations/${org.body.id}`, { body: { ...fields, status: "active" }, headers: { "if-match": org.headers.etag } });
    return { status: act.status, id: org.body.id };
  };
  const orgA = await makeOrg("a"), orgB = await makeOrg("b");
  check("two active buyer organizations", orgA.status === 200 && orgB.status === 200, `${orgA.status}/${orgB.status}`);

  const invite = (orgId) => http.call(tokens.system_admin, "POST", `/buyer-organizations/${orgId}/members`, { body: { email: existingEmail, role: "buyer_member" } });
  const invA = await invite(orgA.id);
  // متابعة الأمن #304: الرد بشكل الدعوة الناجحة، بلا أي حقل يكشف أن البريد لحساب قائم
  check("the conflicting invite answers exactly like a successful one (201, invited, no conflict field)",
    invA.status === 201 && invA.body?.status === "invited" && !("conflict" in (invA.body ?? {})) && !("existing_user_id" in (invA.body ?? {})) && !("state" in (invA.body ?? {})),
    `status ${invA.status} keys ${Object.keys(invA.body ?? {}).join(",")}`);
  check("a non-admin role cannot read the conflict queue (403)", (await http.get(tokens.buyer_admin, "/buyer-invite-conflicts")).status === 403);

  const queue = async () => (await http.get(tokens.system_admin, "/buyer-invite-conflicts?state=pending&limit=50")).body?.items ?? [];
  const findConflict = async (orgId) => (await queue()).find((c) => c.organization_id === orgId && c.email === existingEmail);
  const c1 = await findConflict(orgA.id);
  check("the conflict appears in the admin queue as pending", Boolean(c1?.id) && c1?.state === "pending", JSON.stringify(c1 ?? null));

  const resolve = (conflictId, code) => http.call(tokens.system_admin, "POST", `/buyer-invite-conflicts/${conflictId}/resolve`, { body: { state: "suspended", totp_code: code } });

  // ---------- الرمز الصحيح مرة واحدة ----------
  const code = totpCode(secret);
  const usedAt = Date.now();
  const first = await resolve(c1?.id, code);
  check("the correct code resolves the conflict once", first.status === 200 && first.body?.state === "suspended", `status ${first.status} ${first.text?.slice?.(0, 120)}`);
  check("the resolved conflict leaves the pending queue", !(await findConflict(orgA.id)));

  // ---------- الرمز نفسه لا يُقبل مرتين ----------
  const invB = await invite(orgB.id);
  const c2 = invB.status === 201 ? await findConflict(orgB.id) : null;
  check("a second conflict for the same email on another organization", invB.status === 201 && Boolean(c2?.id), `status ${invB.status}`);
  if (c2?.id) {
    const reused = await resolve(c2.id, code);
    const withinWindow = Date.now() - usedAt <= 60_000; // الرمز مقبول في خطوته والمجاورتين (حتى 90 ث)
    if (!withinWindow) defer("code reuse", "أكثر من 60 ثانية بين الاستعمالين فالرفض لا يثبت منع إعادة الاستعمال");
    else check("the same correct code is not accepted twice (401 totp_required)", reused.status === 401 && reused.body?.code === "totp_required", `status ${reused.status} ${reused.body?.code}`);
  }

  // ---------- المحاولات الخاطئة تتجاوز الحد ← 429 ----------
  let first429 = 0, wrongSent = 0, clean = true;
  if (c2?.id) {
    for (let i = 1; i <= maxAttempts && !first429; i++) {
      const r = await resolve(c2.id, wrongCode(secret));
      wrongSent = i;
      if (r.status === 429) {
        first429 = i;
        const retryAfter = Number(r.headers?.["retry-after"]);
        check("the 429 is rate_limited with a positive Retry-After", r.body?.code === "rate_limited" && Number.isInteger(retryAfter) && retryAfter > 0, `${r.body?.code} retry-after=${r.headers?.["retry-after"]}`);
        metrics.retry_after_s = Number.isInteger(retryAfter) ? retryAfter : undefined;
      } else if (!(r.status === 401 && r.body?.code === "totp_required")) {
        clean = false;
        check("a wrong code is refused as 401 totp_required (no other status, no state change)", false, `attempt ${i}: status ${r.status} ${r.body?.code ?? ""}`);
      }
    }
    check(`failed attempts beyond the limit are cut off with 429 (within ${maxAttempts} tries)`, first429 > 0, first429 ? `429 at wrong attempt ${first429}` : `no 429 after ${wrongSent} wrong attempts (server limit may exceed ICT_MAX_ATTEMPTS)`);
    if (clean && first429 > 0) console.log(`ok   every wrong code was 401 until the ${first429}th, which was 429`);
    metrics.wrong_attempts_before_429 = first429 > 0 ? first429 : wrongSent;
    if (first429 > 0) {
      const limited = await resolve(c2.id, totpCode(secret));
      check("even a correct code is 429 while the limit holds (the check precedes verification)", limited.status === 429, `status ${limited.status}`);
    }
    const after = (await queue()).find((c) => c.id === c2.id);
    check("after all the failures the conflict is still pending, untouched", after?.state === "pending", JSON.stringify(after?.state));
  }

  const failed = fails.length > 0;
  // لا «pass»: مستخدمون اصطناعيون وتشغيل واحد، ونافذة انتهاء الحد الزمنية لا تُنتَظر
  finish(doc, failed ? "fail" : "partial", { variant: "totp-guard-local", ...metrics, failures: fails.length },
    ["بيئة محلية بمستخدمين اصطناعيين وتشغيل واحد؛ لا يُنتَظر انتهاء نافذة الحد (15 دقيقة افتراضيًا) فيُقاس القطع لا التعافي",
     deferred.length ? `مؤجَّل: ${deferred.join("؛ ")}` : null].filter(Boolean).join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "totp" }));
  return { code: failed ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
