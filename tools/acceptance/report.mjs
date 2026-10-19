#!/usr/bin/env node
// Unified acceptance report: every result under docs/measurements/ in one table, plus every row of the acceptance
// table with its latest status. This is the reference for the foundation-phase gate review.
//   node report.mjs                       Markdown on stdout
//   node report.mjs --out=REPORT.md       also write a file
//   node report.mjs --summary             append to $GITHUB_STEP_SUMMARY (CI)
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CATALOG } from "./lib/catalog.mjs";
import { ROOT, parseArgs } from "./lib/measurement.mjs";

const HEADLINE = {
  "upload-resume": ["file.size_bytes", "interruptions", "resent_pct", "sha256_match"],
  "field-network-upload": ["loss_mode", "efficiency_vs_mathis", "bytes_lost_on_resume", "upload_complete", "checksum_match"],
  "receipt-notification": ["creation_to_task_within_60s_pct", "verification_to_receipt_s_p95", "escalation_to_editor_s", "escalation_to_admin_s"],
  "concurrent-load": ["concurrency", "file_size_mb", "notification_s_p95_load", "degradation_ratio_p95"],
  performance: ["list_materials_ms_p95", "material_detail_ms_p95", "inbox_ms_p95"],
  "tenant-isolation": ["cases_executed", "cases_failed", "cases_unimplemented"],
  "pii-leak": ["live_requests", "live_findings", "static_findings"],
  "invalid-file": ["hook_calls", "failed_reasons_checked", "failures"],
  "dynamic-fields": ["server_cases_matching", "conformance_cases", "platforms_judged"],
  "duplicate-payment": ["write_operations_checked", "write_operations_unimplemented", "failures"],
  "task-killers": ["vendor", "locked_minutes", "interventions_before_complete", "completed"],
};
const ICON = { pass: "✅ pass", partial: "◐ partial", fail: "❌ fail", info: "ℹ info", none: "— لا نتيجة" };

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (e.endsWith(".json")) yield p;
  }
}

const get = (doc, path) => path.split(".").reduce((o, k) => o?.[k], { ...doc, ...doc.metrics, file: doc.file });
const fmt = (v) => (typeof v === "number" ? String(Number.isInteger(v) ? v : Number(v.toFixed(2))) : String(v));

export function buildReport(entries, now = new Date()) {
  const key = (d) => `${d.tool}|${d.test_name ?? "-"}|${d.network?.profile ?? "-"}`;
  const latest = new Map();
  const count = new Map();
  for (const { doc, file } of entries) {
    const k = key(doc);
    count.set(k, (count.get(k) ?? 0) + 1);
    const cur = latest.get(k);
    if (!cur || Date.parse(doc.started_at) > Date.parse(cur.doc.started_at)) latest.set(k, { doc, file });
  }
  const rows = [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, { doc, file }]) => {
    const head = (HEADLINE[doc.test_name] ?? Object.keys(doc.metrics))
      .map((m) => [m.split(".").pop(), get(doc, m)]).filter(([, v]) => v !== undefined && v !== null).slice(0, 4).map(([m, v]) => `${m}=${fmt(v)}`).join("، ");
    return `| ${doc.test_name ?? "—"} | ${doc.tool} | ${doc.network?.profile ?? "—"} | ${ICON[doc.result]} | ${head || "—"} | ${doc.started_at.slice(0, 10)} | ${count.get(k)} | \`${file}\` |`;
  });

  const byTest = new Map();
  for (const { doc } of entries) {
    if (doc.tool !== "acceptance" && !CATALOG.some((t) => t.name === doc.test_name)) continue;
    const t = doc.test_name;
    if (!byTest.has(t)) byTest.set(t, []);
    byTest.get(t).push(doc);
  }
  const rank = { fail: 0, partial: 1, info: 2, pass: 3 };
  const status = (name) => {
    const docs = byTest.get(name) ?? [];
    if (!docs.length) return "none";
    // a row is as good as the best latest result, and a failure in the latest result of any run profile pulls it down
    const latestByKey = [...new Map(docs.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).map((d) => [key(d) + (d.metrics.live_checked === false ? "|static" : ""), d])).values()];
    return latestByKey.some((d) => d.result === "fail") ? "fail" : latestByKey.map((d) => d.result).sort((a, b) => rank[b] - rank[a])[0];
  };
  const table = CATALOG.map((t) => {
    const st = status(t.name);
    return `| ${t.name} | ${t.mode} | ${ICON[st]} | ${t.criterion.length > 90 ? `${t.criterion.slice(0, 90)}…` : t.criterion} |`;
  });
  const tally = CATALOG.reduce((o, t) => ({ ...o, [status(t.name)]: (o[status(t.name)] ?? 0) + 1 }), {});

  return [
    "# تقرير القبول الموحّد",
    "",
    `مولَّد آليًا من \`docs/measurements/\` بـ \`tools/acceptance/report.mjs\` (${now.toISOString().slice(0, 10)}). لا يُعدَّل يدويًا. «pass» لا يُكتب إلا حين يكون الدليل كاملًا؛ ما دونه \`partial\` مع السبب في ملف النتيجة.`,
    "",
    "## صفوف جدول اختبارات القبول",
    "",
    `الخلاصة: pass ${tally.pass ?? 0}، partial ${tally.partial ?? 0}، fail ${tally.fail ?? 0}، info ${tally.info ?? 0}، بلا نتيجة ${tally.none ?? 0} من ${CATALOG.length}.`,
    "",
    "| الاختبار | النمط | الحالة | المعيار |",
    "| --- | --- | --- | --- |",
    ...table,
    "",
    "## كل النتائج (الأحدث لكل أداة/اختبار/ملف شبكة)",
    "",
    "| الاختبار | الأداة | الشبكة | الحالة | الأرقام | التاريخ | التشغيلات | الملف |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export function loadEntries(dir = join(ROOT, "docs/measurements")) {
  return [...files(dir)].map((f) => ({ doc: JSON.parse(readFileSync(f, "utf8")), file: relative(ROOT, f) }));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = parseArgs(process.argv.slice(2));
  const md = buildReport(loadEntries());
  if (args.out) writeFileSync(args.out, md);
  if (args.summary && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  if (!args.out && !args.summary) process.stdout.write(md);
}
