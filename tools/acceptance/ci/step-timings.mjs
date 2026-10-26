#!/usr/bin/env node
// مدة كل خطوة في وظيفة CI الجارية، كملف قياس بمخطط measurement.json يُطبع ويُرفع مع بقية نتائج الوظيفة.
// تقرأ خطوات وظيفتها من واجهة GitHub (GITHUB_TOKEN بصلاحية actions: read) وتجد وظيفتها باسم المنفّذ RUNNER_NAME؛ الخطوة الجارية
// (هذه نفسها) لا وقت انتهاء لها فتُهمَل. خارج CI (بلا هذه المتغيرات) لا تقيس شيئًا وتخرج بـ 2. النتيجة `info`: توقيت لا حكم.
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "step";

/** من خطوات الوظيفة: [{ name, seconds }] للمنتهية وحدها، وإجمالي الوقت وأبطأ خطوة. */
export function summarize(job) {
  const steps = (job.steps ?? [])
    .filter((s) => s.started_at && s.completed_at && s.conclusion !== "skipped")
    .map((s) => ({ number: s.number, name: s.name, seconds: Math.max(0, Math.round((Date.parse(s.completed_at) - Date.parse(s.started_at)) / 1000)) }));
  const slowest = steps.reduce((a, b) => (b.seconds > (a?.seconds ?? -1) ? b : a), null);
  const started = Date.parse(job.started_at), ended = Date.parse(steps.length ? job.steps.filter((s) => s.completed_at).at(-1).completed_at : job.started_at);
  return { steps, slowest, total_s: Number.isFinite(started) ? Math.round((ended - started) / 1000) : null };
}

export function timingsDoc(job, env = {}) {
  const sum = summarize(job);
  const metrics = { total_s: sum.total_s ?? "unverified", steps: sum.steps.length, slowest_step: sum.slowest ? slug(sum.slowest.name) : "none", slowest_step_s: sum.slowest?.seconds ?? 0 };
  for (const s of sum.steps) metrics[`step_${String(s.number).padStart(2, "0")}_${slug(s.name)}_s`] = s.seconds;
  const doc = newResult("ci-step-timings", { device: { platform: "server", model: env.RUNNER_NAME ? `GitHub-hosted ${env.RUNNER_NAME}` : "CI runner" }, upload_path: "n/a", network: { profile: "github-hosted" } });
  return finish(doc, "info", metrics, `مدة كل خطوة منتهية في وظيفة «${job.name}» (محاولة ${job.run_attempt ?? 1}). توقيت لا حكم: الخطوات الجارية وقت القراءة لا تُحسب.`);
}

export async function run(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const args = parseArgs(argv);
  const need = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "RUNNER_NAME"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const res = await fetchImpl(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT ?? 1}/jobs?per_page=100`, {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) { console.error(`step timings: GitHub answered ${res.status}; nothing measured`); return { code: 2, doc: null }; }
  const jobs = (await res.json()).jobs ?? [];
  const job = jobs.find((j) => j.runner_name === env.RUNNER_NAME);
  if (!job) { console.error("step timings: this job is not in the run's job list; nothing measured"); return { code: 2, doc: null }; }
  const doc = timingsDoc(job, env);
  for (const [k, v] of Object.entries(doc.metrics).filter(([k]) => /^step_/.test(k))) console.log(`${String(v).padStart(5)} s  ${k}`);
  console.log(`total ${doc.metrics.total_s} s; slowest ${doc.metrics.slowest_step} (${doc.metrics.slowest_step_s} s)`);
  console.log(args["dry-run"] ? "dry run" : `wrote ${writeResult(doc, { slug: "ci" })}`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  return { code: 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
