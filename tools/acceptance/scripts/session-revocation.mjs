// session-revocation (SEC-01, server side): a session revoked from another device stops working within seconds, on the API
// and on the upload path. Measured against the compose stack with the real tusd behind tusd-proxy.
//   REVOKE_API_URL (http://127.0.0.1:3000/v1)   REVOKE_TUS_URL (http://127.0.0.1:8080/files/)   DATABASE_URL (seed)
//   REVOKE_MAX_S   the proposed criterion for "within seconds" (default 5, see below)
// Flow, with two logins of one reporter (A = the lost phone, B = another device):
//   1. A opens an upload and sends the first part.
//   2. B revokes A alone (DELETE /auth/sessions/{A}): A's access and refresh tokens must be refused, B keeps working.
//   3. B revokes every session (POST /auth/logout all_sessions): B's tokens are refused too; an upload token that has not
//      created its tusd upload yet is refused by tusd; and the upload already in flight is tried on its next part.
// "Within seconds" is turned into a number from the measurement: the criterion is ≤ REVOKE_MAX_S seconds from the revoke call's
// answer to the first refusal; the measured times are in the result, so the number can be tightened or relaxed on evidence.
// Known finding (waivers/session-revocation.json): tusd serves the next PATCH of an upload already created without asking the
// server, so an in-flight transfer is not stopped server-side until the ingest gate (ADR 0011) or a post-receive hook exists.
import { createHash, randomBytes } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { client, createUploadSession, eventsOfType, materialBody, sleep } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";
import { loadWaivers } from "../lib/waivers.mjs";
import { seed } from "../live/seed.mjs";

const PART = 8 * 1024 * 1024, PARTS = 3;
const b64 = (s) => Buffer.from(String(s)).toString("base64");
const TUS = { "Tus-Resumable": "1.0.0" };

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const test = { name: "session-revocation", criterion: "SEC-01: رمز مبطَل يُرفض خلال ثوانٍ (على الخادم وعلى مسار الرفع)، والرفع الجاري يتوقف عند الجزء التالي" };
  banner(test);
  if (!env.REVOKE_API_URL || !env.DATABASE_URL) {
    console.error("ENVIRONMENT: REVOKE_API_URL and DATABASE_URL are required; nothing measured");
    return { code: 2, doc: null };
  }
  const maxS = Number(env.REVOKE_MAX_S ?? 5), tusUrl = env.REVOKE_TUS_URL;
  const waivers = loadWaivers("session-revocation");
  const doc = newResult("session-revocation", { device: { platform: "server", model: env.REVOKE_ENV_LABEL ?? "compose: api + tusd + tusd-proxy + postgres + redis" }, upload_path: tusUrl ? "tusd" : "n/a" });
  const fails = [], findings = [], notMeasured = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); };
  const m = {};

  const s = await seed({ databaseUrl: env.DATABASE_URL, apiUrl: env.REVOKE_API_URL });
  const api = client(env.REVOKE_API_URL);
  const reporter = s.users.reporter;
  const login = async () => {
    const r = await api.call(null, "POST", "/auth/login", { body: { email: reporter.email, password: s.password }, key: null });
    if (r.status !== 200) throw new Error(`login answered ${r.status}`);
    return r.body;
  };
  const A = await login(), B = await login();
  const sessionsOf = async (tok) => (await api.get(tok, "/auth/sessions")).body.items ?? [];
  const aId = (await sessionsOf(A.access_token)).find((x) => x.current)?.id;
  check("two sessions of the reporter exist and A's id is readable", Boolean(aId) && (await sessionsOf(B.access_token)).length >= 2);

  // seconds until `probe()` first answers with a refusal (null = never within the budget); polled every 100 ms
  const untilRefused = async (probe, budgetMs = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const status = await probe();
      if (status === 401 || status === 403) return (Date.now() - t0) / 1000;
      if (Date.now() - t0 > budgetMs) return null;
      await sleep(100);
    }
  };
  const meStatus = (tok) => async () => (await api.get(tok, "/auth/me")).status;
  const refreshStatus = (rt) => async () => (await api.call(null, "POST", "/auth/refresh", { body: { refresh_token: rt }, key: null })).status;
  const within = (name, seconds) => check(`${name} refused within ${maxS} s`, seconds !== null && seconds <= maxS, seconds === null ? "never refused" : `${seconds} s`);

  // ---- the upload A has in flight, and an upload token not used yet
  let inflight = null, unused = null, location = null;
  const tusCreate = (session, size) => fetch(tusUrl, { method: "POST", headers: { ...TUS, "Upload-Length": String(size), "Upload-Metadata": `upload_session_id ${b64(session.id)},filename ${b64("r.bin")}`, Authorization: `Bearer ${session.token}` } });
  const file = Buffer.alloc(PART * PARTS, 7), fileSha = createHash("sha256").update(file).digest("hex");
  if (tusUrl) {
    const fv = (await api.get(A.access_token, "/forms/current")).body.version;
    const mk = async (tag) => (await api.call(A.access_token, "POST", "/materials", { body: materialBody(fv, `revocation-${tag}-${Date.now()}`) })).body;
    inflight = await createUploadSession(api, A.access_token, { materialId: (await mk("inflight")).id, size: file.length, clientSha256: fileSha });
    const small = randomBytes(1024);
    unused = await createUploadSession(api, A.access_token, { materialId: (await mk("unused")).id, size: small.length, clientSha256: createHash("sha256").update(small).digest("hex") });
    const made = await tusCreate(inflight, file.length);
    check("the in-flight upload is created through tusd-proxy", made.status === 201, `HTTP ${made.status}`);
    location = new URL(made.headers.get("location") ?? "", tusUrl).toString();
    const first = await fetch(location, { method: "PATCH", headers: { ...TUS, "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" }, body: file.subarray(0, PART) });
    check("the first part is accepted", first.status === 204, `HTTP ${first.status}`);
  } else notMeasured.push("مسار الرفع (tusd) لم يُقَس: REVOKE_TUS_URL غير مضبوط");

  // ---- 1. B revokes A alone
  const r1 = await api.call(B.access_token, "DELETE", `/auth/sessions/${aId}`, { key: null });
  check("revoking one session answers 204", r1.status === 204, `HTTP ${r1.status}`);
  m.single_access_refused_s = await untilRefused(meStatus(A.access_token));
  m.single_refresh_refused_s = await untilRefused(refreshStatus(A.refresh_token));
  within("A's access token (single revoke)", m.single_access_refused_s);
  within("A's refresh token (single revoke)", m.single_refresh_refused_s);
  check("B is untouched by revoking A (control)", (await meStatus(B.access_token)()) === 200);
  m.single_listed_after = (await sessionsOf(B.access_token)).some((x) => x.id === aId);
  check("the revoked session no longer appears in B's session list", !m.single_listed_after);

  // ---- 2. B revokes everything
  const r2 = await api.call(B.access_token, "POST", "/auth/logout", { body: { all_sessions: true }, key: null });
  check("logout of all sessions answers 204", r2.status === 204, `HTTP ${r2.status}`);
  m.all_access_refused_s = await untilRefused(meStatus(B.access_token));
  m.all_refresh_refused_s = await untilRefused(refreshStatus(B.refresh_token));
  within("B's access token (all sessions)", m.all_access_refused_s);
  within("B's refresh token (all sessions)", m.all_refresh_refused_s);

  if (tusUrl) {
    // an upload token that never created its upload: tusd's pre-create hook asks the server, which no longer knows the token
    // one try is enough: an accepted create uses the token up, so a second try would be refused for a different reason
    const t0 = Date.now(), tried = await tusCreate(unused, 1024);
    const refusedAt = tried.status >= 400 && tried.status < 500 ? (Date.now() - t0) / 1000 : null;
    m.unused_upload_token_refused_s = refusedAt;
    m.unused_upload_token_status = tried.status;
    within("an unused upload token at tusd", refusedAt);

    // the upload already in flight: its next part
    const second = await fetch(location, { method: "PATCH", headers: { ...TUS, "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(PART) }, body: file.subarray(PART, PART * 2) });
    m.inflight_next_part_status = second.status;
    const stopped = second.status >= 400;
    m.inflight_stopped_at_next_part = stopped;
    if (!stopped) {
      findings.push({ source: "tusd PATCH after revocation", path: "next part of an upload already created", kind: "inflight-continues" });
      // finish it to say what the server does with a transfer of a revoked user
      const third = await fetch(location, { method: "PATCH", headers: { ...TUS, "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(PART * 2) }, body: file.subarray(PART * 2) });
      m.inflight_third_part_status = third.status;
      const C = await login();
      const done = await waitFor(async () => {
        const r = (await api.get(C.access_token, `/uploads/${inflight.id}`)).body;
        return ["verified", "failed", "deduplicated"].includes(r.state) ? r : null;
      }, { timeoutMs: 120_000, everyMs: 500 });
      m.inflight_final_state = done.value?.state ?? "timeout";
      // what the server did with the bytes of a revoked user: receipt, failure reason and the events it emitted for this upload
      const last = done.value ?? (await api.get(C.access_token, `/uploads/${inflight.id}`)).body;
      m.inflight_receipt_issued = Boolean(last.receipt_number);
      m.inflight_failure_reason = last.failure_reason ?? "none";
      const admin = s.tokens.system_admin;
      for (const [key, type] of [["received", "upload.original_received"], ["verified", "upload.verified"], ["failed", "upload.failed"]]) {
        m[`inflight_event_${key}`] = (await eventsOfType(api, admin, type)).some((e) => e.aggregate_id === inflight.id);
      }
    }
    const verdict = (f) => (waivers.isWaived(f) ? "waived" : "open");
    for (const f of findings) {
      const v = verdict(f);
      console.log(`${v === "waived" ? "WAIVED" : "FAIL  "} ${f.kind}: ${f.source} (${f.path})`);
      if (v === "open") fails.push(`${f.kind}: ${f.source}`);
    }
  }
  for (const w of waivers.stale(findings)) {
    fails.push(`stale waiver ${w.kind}: ${w.source}`);
    console.log(`FAIL  stale waiver ${w.kind}: ${w.source} (the finding is gone: delete it from waivers/session-revocation.json)`);
  }

  const waivedCount = findings.filter((f) => waivers.isWaived(f)).length;
  const metrics = { criterion_proposed_s: maxS, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === null ? -1 : typeof v === "number" && k.endsWith("_s") ? Number(v.toFixed(2)) : v])), waived_findings: waivedCount, failures: fails.length };
  const notes = [
    fails.length ? `فشل: ${fails.join("؛ ")}` : null,
    `«خلال ثوانٍ» حُوِّل إلى رقم مقترح: ≤ ${maxS} ث من رد استدعاء الإبطال إلى أول رفض (القيم المقيسة في المقاييس، -1 = لم يُرفض ضمن 15 ث)`,
    m.inflight_final_state ? `الرفع الجاري بعد الإبطال: الحالة النهائية ${m.inflight_final_state}، السبب ${m.inflight_failure_reason}، إيصال ${m.inflight_receipt_issued ? "صدر" : "لم يصدر"}، أحداث: استلام ${m.inflight_event_received}، تحقق ${m.inflight_event_verified}، فشل ${m.inflight_event_failed}؛ الخادم لا يفحص الإبطال عند post-finish (tusd-hooks.service.ts) فاكتمال الرفع غير مضمون الرفض بسبب الإبطال، وما سُجّل هو ما حدث في هذا التشغيل` : null,
    waivedCount ? `${waivedCount} ثغرة معروفة مستثناة بإذن مكتوب في waivers/session-revocation.json: الرفع الجاري يبقى مقبولًا عند tusd بعد الإبطال لأن tusd لا يسأل الخادم عن PATCH لاحق؛ يوقفه رمز بوابة ingest القصير (ADR 0011) أو خطّاف post-receive، ولم يُبنيا في هذه الحزمة` : null,
    ...notMeasured,
    "لم يُقَس: إبطال من جهاز المشرف عبر الإدارة (واجهة)، وزمن العميل (الهاتف) إلى المسح، ونسخة واحدة من الخادم بلا تأخير توزيع بين نسخ",
  ].filter(Boolean).join("؛ ");
  finish(doc, fails.length ? "fail" : "partial", metrics, notes);
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else {
    const dir = args["out-dir"] && args["out-dir"] !== true ? args["out-dir"] : undefined;
    console.log("wrote", writeResult(doc, { slug: "api-and-tusd", ...(dir ? { dir } : {}) }));
  }
  return { code: fails.length ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { code } = await run();
  process.exit(code);
}
