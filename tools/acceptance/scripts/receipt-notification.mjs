// receipt-notification: one task for the supervisor within 60 s of technical verification in 95% of runs;
// an unacknowledged urgent task escalates after the timeout.
//   RECEIPT_API_URL  RECEIPT_TOKENS (one per role)  RECEIPT_RUNS
//   full chain (needs the hook and S3; upload sessions come from POST /uploads):  HOOK_BASE_URL HOOK_TOKEN HOOK_OBJECT_PREFIX HOOK_BUCKET  S3_*
//   RECEIPT_ESCALATION_SECONDS  the server's ESCALATION_URGENT_SECONDS (the harness injects a short one)
// Three measurements:
//   A. creation → supervisor task            (N runs, urgent and normal mixed; no duplicates, reporter not notified of own incoming)
//   B. verification → receipt notification   (post-finish → server SHA-256 → upload.verified → reporter inbox with the receipt number)
//   C. escalation                            (urgent, unacknowledged: editor in chief after the timeout, then system admin; an acknowledged one stays quiet)
import { createHash, randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, materialBody, percentile, sleep } from "../lib/live.mjs";
import { hookClient, simulateUpload, waitFor } from "../lib/hooks.mjs";
import { s3FromEnv } from "../lib/s3.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("receipt-notification"));
  const doc = newResult("receipt-notification", { device: { platform: "server" }, upload_path: "n/a" });
  if (!env.RECEIPT_API_URL) {
    console.error("ENVIRONMENT: RECEIPT_API_URL is not set; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.RECEIPT_TOKENS ?? "{}");
  const runs = Number(env.RECEIPT_RUNS ?? 20);
  const http = client(env.RECEIPT_API_URL);
  const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } };
  const create = async (priority, tag) => (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `receipt-${tag}-${randomUUID().slice(0, 8)}`, { priority }) })).body;
  const inbox = async (role) => (await http.get(tokens[role], "/notifications?limit=100")).body.items ?? [];

  // A. creation -> supervisor task
  const latA = [];
  let missing = 0, duplicates = 0, wrongRecipient = 0;
  for (let i = 0; i < runs; i++) {
    const t0 = Date.now();
    const m = await create(i % 2 ? "urgent" : "normal", `a${i}`);
    const got = await waitFor(async () => { const mine = (await inbox("supervisor")).filter((n) => n.material_id === m.id); return mine.length ? mine : null; }, { timeoutMs: 70_000 });
    if (!got.value) { missing++; continue; }
    latA.push((Date.now() - t0) / 1000);
    if (got.value.length > 1) duplicates++;
    if ((await inbox("reporter")).some((n) => n.material_id === m.id && n.type !== "upload.verified")) wrongRecipient++;
  }
  latA.sort((a, b) => a - b);
  const within60 = latA.filter((l) => l <= 60).length;
  check("creation -> task within 60 s in 95% of runs", runs > 0 && (within60 / runs) * 100 >= 95, `${within60}/${runs}`);
  check("no missing, duplicate or misdirected task", missing + duplicates + wrongRecipient === 0, `missing=${missing} dup=${duplicates} wrong=${wrongRecipient}`);

  // B + C need the hook, storage and database
  const full = env.HOOK_BASE_URL && env.HOOK_TOKEN && s3FromEnv(env);
  const m = { noSecondAssignment: 0, technicalVerified: 0, verifiedRuns: 0, latB: [], receiptsOk: 0, shaOk: 0, esc1: [], esc2: [], escQuiet: null, escBefore: 0 };
  if (full) {
    const hooks = hookClient({ baseUrl: env.HOOK_BASE_URL, token: env.HOOK_TOKEN });
    const s3 = s3FromEnv(env);
    const bucket = env.HOOK_BUCKET ?? "uploads", prefix = env.HOOK_OBJECT_PREFIX ?? "tus/";
    await s3.ensureBucket(bucket);
    try {
      const runsB = Number(env.RECEIPT_VERIFY_RUNS ?? 8);
      for (let i = 0; i < runsB; i++) {
        const mat = await create("normal", `b${i}`);
        const bytes = Buffer.alloc(200_000 + i * 1000, i + 1);
        const session = await createUploadSession(http, tokens.reporter, { materialId: mat.id, bytes });
        const up = await simulateUpload({ hooks, s3, bucket, prefix, session, bytes });
        const got = await waitFor(async () => (await inbox("reporter")).find((n) => n.material_id === mat.id && n.type === "upload.verified"), { timeoutMs: 30_000 });
        if (!got.value) { check(`run ${i}: receipt notification arrives`, false); continue; }
        m.verifiedRuns++;
        m.latB.push((Date.now() - up.finishedAt) / 1000);
        if (/R-\d{6}-\d{6}/.test(got.value.title)) m.receiptsOk++;
        // owner decision: the supervisor is assigned once, at creation; verification updates the row and notifies the reporter, no second assignment
        const mine = (await inbox("supervisor")).filter((n) => n.material_id === mat.id);
        if (mine.length === 1) m.noSecondAssignment++;
        const detail = (await http.get(tokens.reporter, `/materials/${mat.id}`)).body;
        if (detail.technical_state === "verified") m.technicalVerified++;
        const file = detail.files?.find((f) => f.kind === "original");
        if (file?.state === "verified" && file.sha256 === createHash("sha256").update(bytes).digest("hex") && got.value.title.includes(file.receipt_number)) m.shaOk++;
      }
      check("every verified upload notified the reporter with a receipt number", m.verifiedRuns === runsB && m.receiptsOk === runsB, `${m.receiptsOk}/${runsB}`);
      check("server SHA-256 equals the bytes written, and the notification carries that file's receipt", m.shaOk === runsB, `${m.shaOk}/${runsB}`);
      check("verification leaves exactly one supervisor assignment per material (no second task)", m.noSecondAssignment === runsB, `${m.noSecondAssignment}/${runsB}`);
      check("verification moves the material's technical state to verified", m.technicalVerified === runsB, `${m.technicalVerified}/${runsB}`);
      check("receipt notification within 60 s of verification in 95% of runs", m.latB.filter((l) => l <= 60).length / runsB >= 0.95);

      // C. escalation: injected timeout, polled by the server every few hundred ms
      const timeout = Number(env.RECEIPT_ESCALATION_SECONDS ?? 3);
      const urgent = await create("urgent", "esc");
      const tEsc = Date.now();
      // watch both rungs in one loop so each first-seen time is its own, not the other's wait
      const seen = { editor_in_chief: null, system_admin: null };
      while (Date.now() - tEsc < (timeout * 3 + 10) * 1000 && !(seen.editor_in_chief && seen.system_admin)) {
        for (const role of Object.keys(seen)) {
          if (!seen[role] && (await inbox(role)).some((n) => n.material_id === urgent.id && n.type === "notification.escalated")) seen[role] = (Date.now() - tEsc) / 1000;
        }
        await sleep(100);
      }
      const e1 = { value: seen.editor_in_chief }, e2 = { value: seen.system_admin };
      if (e1.value) m.esc1.push(e1.value);
      if (e2.value) m.esc2.push(e2.value);
      check("unacknowledged urgent task escalates to the editor in chief", Boolean(e1.value));
      check("...and then to the system admin", Boolean(e2.value));
      check("escalation does not fire before the timeout", !e1.value || m.esc1[0] >= timeout - 0.5, `${m.esc1[0]}s < ${timeout}s`);
      const quiet = await create("urgent", "esc-ack");
      const task = await waitFor(async () => (await inbox("supervisor")).find((n) => n.material_id === quiet.id), { timeoutMs: 10_000 });
      const ack = task.value ? await http.call(tokens.supervisor, "POST", `/notifications/${task.value.id}/ack`) : { status: 0 };
      check("the supervisor can acknowledge the task", ack.status === 200 || ack.status === 204, `status ${ack.status}`);
      await sleep((timeout + 4) * 1000);
      m.escQuiet = !(await inbox("editor_in_chief")).some((n) => n.material_id === quiet.id && n.type === "notification.escalated");
      check("an acknowledged task never escalates", m.escQuiet);
    } finally { /* nothing to close: no direct database access */ }
  }

  latA.sort((a, b) => a - b);
  console.log(`A: runs=${runs} within60s=${((within60 / runs) * 100).toFixed(1)}% p95=${percentile(latA, 95)}s | B: ${full ? `${m.verifiedRuns} verified, p95=${percentile(m.latB.sort((a, b) => a - b), 95)}s` : "skipped"} | C: ${full ? `esc1=${m.esc1[0]}s esc2=${m.esc2[0]}s quiet=${m.escQuiet}` : "skipped"}`);
  finish(doc, fails.length ? "fail" : "partial", {
    runs, creation_to_task_within_60s_pct: Number(((within60 / runs) * 100).toFixed(1)), creation_to_task_s_p95: percentile(latA, 95), missing_tasks: missing, duplicate_tasks: duplicates, misdirected: wrongRecipient,
    verification_chain_measured: Boolean(full), verified_runs: m.verifiedRuns, verification_to_receipt_s_p95: full ? percentile(m.latB, 95) : "n/a", receipts_ok: m.receiptsOk, server_sha256_ok: m.shaOk,
    escalation_measured: Boolean(full), escalation_timeout_s: Number(env.RECEIPT_ESCALATION_SECONDS ?? 3), escalation_to_editor_s: m.esc1[0] ?? "n/a", escalation_to_admin_s: m.esc2[0] ?? "n/a", acknowledged_task_stayed_quiet: m.escQuiet ?? "n/a",
    supervisor_assigned_once_at_creation: true, no_second_assignment_runs: m.noSecondAssignment, technical_verified_runs: m.technicalVerified, failures: fails.length,
  }, ["قرار المنسّق: تعيين المشرف عند الإنشاء (الوارد الحي يرى المادة فور وصول بياناتها)، و`upload.verified` يحدّث الحالة الفنية ويُشعر المراسل بالإيصال دون تعيين ثانٍ؛ والاختبار يتحقق من الأمرين",
      "عبارة «60 ثانية من التحقق الفني» تُقاس هنا على إشعار الإيصال للمراسل بعد التحقق، وعلى وصول المهمة للمشرف بعد الإنشاء",
      full ? "التحقق والتصعيد قيسا بمهلة محقونة وتخزين S3 فعلي وهوك tusd مُحاكى (لا tusd حقيقي)؛ النتيجة جزئية لغياب عامل الوسائط وتجربة الأجهزة" : "سلسلة التحقق والتصعيد لم تُشغَّل (تحتاج الخطّاف وS3 وقاعدة البيانات)"].join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: full ? "chain-and-escalation" : "created-to-task" }));
  return { code: fails.length ? 1 : 0, doc };
}
