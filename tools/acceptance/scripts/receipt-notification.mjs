// receipt-notification: one task for the supervisor within 60 s of technical verification in 95% of runs;
// an urgent one escalates after the timeout.
// Measured today: from the material.created event (written in the creating transaction) to the supervisor's
// inbox entry, over N runs mixing urgent and normal. Technical verification (SHA-256 by the media worker) and
// the escalation worker do not exist yet, so the 60 s-from-verification claim and the escalation are NOT measured.
//   RECEIPT_API_URL=http://127.0.0.1:13000/v1  RECEIPT_TOKENS='{"reporter":"…","supervisor":"…"}'  RECEIPT_RUNS=30
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody, percentile, sleep } from "../lib/live.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("receipt-notification"));
  const doc = newResult("receipt-notification", { device: { platform: "server" }, upload_path: "n/a" });
  if (!env.RECEIPT_API_URL) {
    console.error("ENVIRONMENT: RECEIPT_API_URL is not set; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.RECEIPT_TOKENS ?? "{}");
  const runs = Number(env.RECEIPT_RUNS ?? 30);
  const http = client(env.RECEIPT_API_URL);
  const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
  const latencies = [];
  let missing = 0, duplicates = 0, wrongRecipients = 0;

  for (let i = 0; i < runs; i++) {
    const priority = i % 2 ? "urgent" : "normal";
    const t0 = Date.now();
    const created = await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `receipt-${randomUUID().slice(0, 8)}-${i}`, { priority }) });
    if (created.status !== 201) throw new Error(`create failed: ${created.status}`);
    const id = created.body.id;
    let seen = null;
    while (Date.now() - t0 < 70_000) {
      const inbox = (await http.get(tokens.supervisor, "/notifications?limit=100")).body.items ?? [];
      const mine = inbox.filter((n) => n.material_id === id);
      if (mine.length) { seen = mine; break; }
      await sleep(100);
    }
    if (!seen) { missing++; continue; }
    latencies.push((Date.now() - t0) / 1000);
    if (seen.length > 1) duplicates++;
    // the reporter must not be notified of their own incoming material
    const own = (await http.get(tokens.reporter, "/notifications?limit=100")).body.items ?? [];
    if (own.some((n) => n.material_id === id && /incoming|واردة/i.test(n.title))) wrongRecipients++;
  }
  latencies.sort((a, b) => a - b);
  const within60 = latencies.filter((l) => l <= 60).length;
  const pct = runs ? (within60 / runs) * 100 : 0;
  const failed = missing > 0 || duplicates > 0 || wrongRecipients > 0 || pct < 95;
  console.log(`runs=${runs} within60s=${pct.toFixed(1)}% p95=${percentile(latencies, 95)}s missing=${missing} duplicates=${duplicates}`);
  finish(doc, failed ? "fail" : "partial", {
    runs, within_60s_pct: Number(pct.toFixed(1)), latency_s_p50: percentile(latencies, 50), latency_s_p95: percentile(latencies, 95), latency_s_max: latencies.at(-1) ?? null,
    missing_notifications: missing, duplicate_tasks: duplicates, wrong_recipient: wrongRecipients,
    measured_from: "material.created", verification_to_task_measured: false, urgent_escalation_measured: false,
  }, "يقيس من حدث الإنشاء إلى وصول المهمة في صندوق المشرف؛ التحقق الفني (عامل الوسائط) وعامل التصعيد للعاجل غير موجودين بعد فلم يُقَس الزمن من التحقق ولا التصعيد، فالنتيجة جزئية");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "created-to-task" }));
  return { code: failed ? 1 : 0, doc };
}
