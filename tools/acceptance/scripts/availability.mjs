// availability: drop the API server, the database and a deploy while requests keep arriving; the recovery time is measured
// against the declared target. Runs against a stack you can drive with docker compose (the field-trial compose on the trial host or
// in CI), through the same address clients use. Under steady read load (AVAIL_LOAD workers, 50 ms apart) for each scenario:
//   api-kill   SIGKILL the API container (the restart policy brings it back)
//   db-kill    SIGKILL Postgres (the API must reconnect by itself; a marker material written before must still be readable)
//   deploy     recreate the API container with the same image (what a deploy does to one instance: the outage window)
// Per scenario: requests, failures, first failure after the action, time until reads stay good (downtime), recovered or not.
//   AVAIL_API_URL=https://main.localhost/v1   AVAIL_TOKEN=<reporter access token>
//   AVAIL_COMPOSE="infra/field-trial/trial.sh"   the compose command prefix; services are api and postgres (AVAIL_API_SERVICE, AVAIL_DB_SERVICE)
//   AVAIL_TARGET_S=<seconds>   the recovery target management declared (decision 8: 99.5% or 99.9%); without it the result is partial
//   AVAIL_TRIAL_HOST=1         the operator states this runs on the trial host, not on a CI runner; without it the result is partial
//   AVAIL_LOAD=4  AVAIL_BASELINE_MS=4000  AVAIL_SETTLE_MS=6000  AVAIL_TIMEOUT_MS=120000
// `pass` needs a declared target, the trial host and every scenario recovered within it with the marker intact. Single instance:
// there is no second API to take the traffic, so a deploy here is an outage window, which the number states.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody, sleep } from "../lib/live.mjs";
import { freshFetch } from "../lib/http.mjs";

const sh = promisify(execFile);

/**
 * Samples are {t, ok} (ms since the load started). `tAction` is when the action began. Downtime runs from the first failure at or after the
 * action to the first success after which every later sample is good (`stable` of them at least); no failure = the dip was shorter
 * than the request interval, reported as 0 and said so. Recovery is false when the tail is still failing.
 */
export function analyze(samples, tAction, stable = 5) {
  const after = samples.filter((s) => s.t >= tAction).sort((a, b) => a.t - b.t);
  const failures = after.filter((s) => !s.ok);
  const first = failures[0] ?? null;
  const tail = after.slice(-stable);
  const recovered = after.length >= stable && tail.every((s) => s.ok);
  let recoveredAt = null;
  if (recovered) {
    const lastBad = failures.at(-1);
    recoveredAt = lastBad ? (after.find((s) => s.t > lastBad.t && s.ok)?.t ?? null) : (first?.t ?? tAction);
  }
  return {
    requests: samples.length, failures: failures.length,
    first_failure_ms: first ? first.t - tAction : null,
    downtime_s: !first ? 0 : recovered && recoveredAt !== null ? (recoveredAt - first.t) / 1000 : null,
    recovered, dipped: Boolean(first),
  };
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("availability"));
  if (!env.AVAIL_API_URL || !env.AVAIL_TOKEN || !env.AVAIL_COMPOSE) {
    console.error("ENVIRONMENT: AVAIL_API_URL, AVAIL_TOKEN and AVAIL_COMPOSE are required; nothing measured (this script drives docker compose)");
    return { code: 2, doc: null };
  }
  const exec = deps.exec ?? (async (cmd) => { await sh("sh", ["-c", cmd], { env }); });
  const http = client(env.AVAIL_API_URL, deps.fetchImpl ?? freshFetch);
  const num = (k, d) => Number(env[k] ?? d);
  const load = num("AVAIL_LOAD", 4), baselineMs = num("AVAIL_BASELINE_MS", 4000), settleMs = num("AVAIL_SETTLE_MS", 6000), timeoutMs = num("AVAIL_TIMEOUT_MS", 120000), gapMs = num("AVAIL_GAP_MS", 50);
  const api = env.AVAIL_API_SERVICE ?? "api", db = env.AVAIL_DB_SERVICE ?? "postgres";
  const target = env.AVAIL_TARGET_S ? Number(env.AVAIL_TARGET_S) : null, trialHost = env.AVAIL_TRIAL_HOST === "1";
  const doc = newResult("availability", { device: { platform: "server" }, upload_path: "n/a" });

  const fv = (await http.get(env.AVAIL_TOKEN, "/forms/current")).body?.version;
  const marker = await http.call(env.AVAIL_TOKEN, "POST", "/materials", { body: materialBody(fv, `availability-marker-${Date.now().toString(36)}`) });
  if (marker.status !== 201 || !marker.body?.id) { console.error(`ENVIRONMENT: the marker material was not created (${marker.status}); nothing measured`); return { code: 2, doc: null }; }

  async function scenario(name, action) {
    const samples = []; let stop = false;
    const t0 = Date.now();
    const worker = async () => {
      while (!stop) {
        const t = Date.now() - t0;
        const ok = await Promise.race([http.get(env.AVAIL_TOKEN, "/materials?limit=1").then((r) => r.status === 200, () => false), sleep(1500).then(() => false)]);
        samples.push({ t, ok });
        await sleep(gapMs);
      }
    };
    const workers = Array.from({ length: load }, worker);
    await sleep(baselineMs);
    const baseline = samples.filter((s) => !s.ok).length;
    const tAction = Date.now() - t0;
    await action();
    const deadline = Date.now() + timeoutMs;
    let a;
    do { await sleep(Math.max(settleMs / 6, 20)); a = analyze(samples, tAction); } while (Date.now() < deadline && !(a.recovered && Date.now() - t0 - tAction >= settleMs));
    stop = true; await Promise.all(workers);
    a = analyze(samples, tAction);
    console.log(`${a.recovered && baseline === 0 ? "ok  " : "FAIL"} ${name}: ${a.requests} requests, ${a.failures} failed, downtime ${a.downtime_s === null ? "not recovered" : `${a.downtime_s.toFixed(2)} s`}, baseline failures ${baseline}`);
    return { ...a, baseline_failures: baseline };
  }

  const results = {};
  results["api-kill"] = await scenario("api-kill", () => exec(`${env.AVAIL_COMPOSE} kill -s KILL ${api}`));
  results["db-kill"] = await scenario("db-kill", () => exec(`${env.AVAIL_COMPOSE} kill -s KILL ${db}`));
  const still = await http.get(env.AVAIL_TOKEN, `/materials/${marker.body.id}`);
  const markerIntact = still.status === 200 && still.body?.id === marker.body.id;
  console.log(`${markerIntact ? "ok  " : "FAIL"} the marker material written before the database was killed is still readable (${still.status})`);
  results.deploy = await scenario("deploy", () => exec(`${env.AVAIL_COMPOSE} up -d --no-deps --force-recreate ${api}`));

  const all = Object.values(results);
  const recovered = all.every((r) => r.recovered && r.baseline_failures === 0);
  const worst = Math.max(...all.map((r) => r.downtime_s ?? Infinity));
  const withinTarget = target !== null && worst <= target;
  const result = !recovered || !markerIntact ? "fail" : target !== null && trialHost && withinTarget ? "pass" : "partial";
  const metrics = { marker_intact: markerIntact, load_workers: load, worst_downtime_s: Number.isFinite(worst) ? Number(worst.toFixed(3)) : -1, target_s: target ?? -1, trial_host: trialHost };
  for (const [k, r] of Object.entries(results)) {
    const key = k.replace("-", "_");
    metrics[`${key}_downtime_s`] = r.downtime_s === null ? -1 : Number(r.downtime_s.toFixed(3));
    metrics[`${key}_failed_requests`] = r.failures;
    metrics[`${key}_requests`] = r.requests;
  }
  finish(doc, result, metrics,
    `إسقاط الخادم (SIGKILL) وقاعدة البيانات (SIGKILL) وإعادة إنشاء حاوية الخادم (ما يفعله النشر لنسخة واحدة) تحت قراءة متواصلة (${load} عامل كل ${gapMs} مللي ثانية) عبر العنوان الذي يصله العملاء؛ الأرقام زمن انقطاع القراءة حتى استقرارها (-1 = لم تتعافَ). نسخة خادم واحدة: لا نسخة ثانية تتلقى الحركة أثناء النشر، فالنشر انقطاع بالرقم المذكور. ${target === null ? "لا هدف تعافٍ معلن من الإدارة (قرار 8) فلا حكم pass." : `الهدف المعلن ${target} ث.`} ${trialHost ? "" : "لم يُصرَّح أنه مضيف التجربة (AVAIL_TRIAL_HOST=1): قياس بيئة اختبار لا يثبت الهدف."}`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: result === "fail" ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
