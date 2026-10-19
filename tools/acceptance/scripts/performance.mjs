// performance: preview of a 10-minute 1080p clip within the measured foundation target, and text search under
// 2 s in 95% of requests on an agreed index and load.
// Neither a preview pipeline nor search exists yet, so this measures what does: API read latency under concurrent load
// (the list, the detail and the inbox) over a seeded set, and fails when the p95 of any of them exceeds 2 s.
//   PERF_API_URL  PERF_TOKENS  PERF_MATERIALS=200  PERF_CONCURRENCY=20  PERF_REQUESTS=400
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody, percentile } from "../lib/live.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("performance"));
  const doc = newResult("performance", { device: { platform: "server" }, upload_path: "n/a" });
  if (!env.PERF_API_URL) {
    console.error("ENVIRONMENT: PERF_API_URL is not set; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.PERF_TOKENS ?? "{}");
  const M = Number(env.PERF_MATERIALS ?? 200), C = Number(env.PERF_CONCURRENCY ?? 20), R = Number(env.PERF_REQUESTS ?? 400);
  const http = client(env.PERF_API_URL);
  const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
  const ids = [];
  const tag = randomUUID().slice(0, 6);
  for (let i = 0; i < M; i += C) {
    const batch = await Promise.all(Array.from({ length: Math.min(C, M - i) }, (_, j) => http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `perf-${tag}-${i + j}`, { priority: (i + j) % 7 === 0 ? "urgent" : "normal" }) })));
    for (const b of batch) if (b.status === 201) ids.push(b.body.id);
  }
  const scenarios = {
    list_materials: () => http.get(tokens.editor_in_chief, "/materials?limit=50"),
    list_materials_reporter: () => http.get(tokens.reporter, "/materials?limit=50"),
    material_detail: () => http.get(tokens.editor_in_chief, `/materials/${ids[Math.floor(Math.random() * ids.length)]}`),
    inbox: () => http.get(tokens.supervisor, "/notifications?limit=50"),
  };
  const out = {}, fails = [];
  for (const [name, call] of Object.entries(scenarios)) {
    const times = [];
    let errors = 0, next = 0;
    const worker = async () => {
      while (next < R) {
        next++;
        const t0 = performance.now();
        const r = await call();
        times.push(performance.now() - t0);
        if (r.status !== 200) errors++;
      }
    };
    await Promise.all(Array.from({ length: C }, worker));
    times.sort((a, b) => a - b);
    out[name] = { p50: Math.round(percentile(times, 50)), p95: Math.round(percentile(times, 95)), p99: Math.round(percentile(times, 99)), errors };
    console.log(`${name.padEnd(26)} p50=${out[name].p50}ms p95=${out[name].p95}ms p99=${out[name].p99}ms errors=${errors}`);
    if (out[name].p95 > 2000) fails.push(`${name} p95 ${out[name].p95} ms > 2000`);
    if (errors) fails.push(`${name}: ${errors} non-200 responses`);
  }
  fails.forEach((f) => console.log(`FAIL ${f}`));
  finish(doc, fails.length ? "fail" : "partial", {
    materials_seeded: ids.length, concurrency: C, requests_per_scenario: R,
    ...Object.fromEntries(Object.entries(out).flatMap(([k, v]) => [[`${k}_ms_p50`, v.p50], [`${k}_ms_p95`, v.p95], [`${k}_ms_p99`, v.p99]])),
    text_search_measured: false, preview_10min_1080p_measured: false, failures: fails.length,
  }, "يقيس زمن قراءة الواجهة (القائمة والتفصيل والصندوق) تحت حمل متزامن على قاعدة اصطناعية؛ البحث النصي ومعاينة مقطع 10 دقائق غير موجودين بعد فلم يُقاسا، والنتيجة جزئية. أحجام الخطة (فهرس وحمل متفق عليهما) بعد وجود البحث");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: `api-read-${M}m` }));
  return { code: fails.length ? 1 : 0, doc };
}
