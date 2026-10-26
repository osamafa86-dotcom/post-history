#!/usr/bin/env node
// payout-concurrent (ADR 0033: «لا صرف فوق المتاح ولو تزامن طلبان»): simultaneous payout requests that together exceed the reporter's available balance are
// served only up to it, judged from outside. A sandbox sale is paid, the payout worker releases it to «available», then
//   round 1: 5 requests of 2000 at once  -> exactly min(5, floor(available / 2000)) answer 201, the rest 422, available and in-payout add up;
//   all of them are cancelled (the balance returns whole);
//   round 2: 2 requests of 4000 at once  -> exactly one answers 201 when 4000 < available < 8000.
// After every round no contributor payable account is on the debit side. `partial` always: sandbox provider and channel, one reporter, one run.
// Needs the sandbox run's environment (SP_API_URL, SP_ROOT_URL, SP_DATABASE_URL, SP_WEBHOOK_SECRET, SP_TOKENS) and the server started with
// PAYOUT_RELEASE_AFTER_DAYS=0, a short PAYOUT_WORKER_INTERVAL_MS and PAYOUT_DEFAULT_MINIMUM_MINOR <= 2000. A server without the earnings routes (404) is "not built yet".
import { join } from "node:path";
import pg from "pg";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";
import { DEBIT_BALANCE_SQL, expectedAccepted, fixtures, judgeDebitBalances } from "./payout-fixtures.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("payout-concurrent"));
  const need = ["SP_API_URL", "SP_ROOT_URL", "SP_DATABASE_URL", "SP_WEBHOOK_SECRET", "SP_TOKENS"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.SP_TOKENS);
  const http = client(env.SP_API_URL), db = new pg.Client({ connectionString: env.SP_DATABASE_URL });
  const doc = newResult("payout-concurrent", { device: { platform: "server", model: env.SP_ENV_LABEL ?? "server" }, upload_path: "n/a" });
  const fails = [], deferred = [], metrics = {};
  let checks = 0;
  const check = (name, ok, why = "") => { checks++; if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  await db.connect();
  try {
    const f = fixtures({ http, tokens, db, root: env.SP_ROOT_URL.replace(/\/$/, ""), secret: env.SP_WEBHOOK_SECRET });
    if ((await http.get(tokens.reporter, "/me/earnings")).status === 404) {
      deferred.push("GET /me/earnings is not served yet");
      console.log("DEFERRED earnings and payout routes are not served yet");
    } else {
      const base0 = (await f.earnings())?.available ?? 0n;
      await f.sale("concurrent");
      const reached = await f.untilAvailable(base0 + 7001n);
      check("the sale is released to «available» by the payout worker", reached !== null, "available never reached the reporter's share in 20 s");
      if (reached) {
        const start = reached.available;
        metrics.available_minor = Number(start);
        const round = async (n, unit) => {
          const results = await Promise.all(Array.from({ length: n }, () => f.requestPayout(unit)));
          return { ok: results.filter((r) => r.status === 201), refused: results.filter((r) => r.status === 422), other: results.filter((r) => r.status !== 201 && r.status !== 422) };
        };
        // ---- round 1: five requests of 2000 ----
        const want1 = expectedAccepted(start, 2000n, 5);
        const r1 = await round(5, 2000);
        check(`round 1: exactly ${want1} of 5 simultaneous requests of 2000 are accepted (available ${start})`, r1.ok.length === want1 && r1.other.length === 0, `201: ${r1.ok.length}, 422: ${r1.refused.length}, other: ${r1.other.map((r) => r.status).join(",")}`);
        const after1 = await f.earnings();
        check("round 1: «in payout» holds exactly what was accepted and «available» the rest, nothing lost", after1.in_payout === BigInt(2000 * r1.ok.length) && after1.available === start - BigInt(2000 * r1.ok.length), `in_payout ${after1.in_payout}, available ${after1.available}`);
        check("round 1: no payable account went to the debit side", judgeDebitBalances(await f.q(DEBIT_BALANCE_SQL)).length === 0, judgeDebitBalances(await f.q(DEBIT_BALANCE_SQL)).join("; "));
        const cancelled = await Promise.all(r1.ok.map((r) => http.call(tokens.reporter, "POST", `/payout-requests/${r.body.id}/cancel`, { body: {} })));
        check("the accepted requests are cancelled by their owner and the balance returns whole", cancelled.every((r) => r.status === 200) && (await f.earnings()).available === start, `statuses ${cancelled.map((r) => r.status).join(",")}`);
        // ---- round 2: two requests of 4000 ----
        const want2 = expectedAccepted(start, 4000n, 2);
        const r2 = await round(2, 4000);
        check(`round 2: exactly ${want2} of 2 simultaneous requests of 4000 is accepted (available ${start})`, r2.ok.length === want2 && r2.other.length === 0, `201: ${r2.ok.length}, 422: ${r2.refused.length}, other: ${r2.other.map((r) => r.status).join(",")}`);
        const after2 = await f.earnings();
        check("round 2: the balance split is exact", after2.in_payout === BigInt(4000 * r2.ok.length) && after2.available === start - BigInt(4000 * r2.ok.length), `in_payout ${after2.in_payout}, available ${after2.available}`);
        check("round 2: no payable account went to the debit side", judgeDebitBalances(await f.q(DEBIT_BALANCE_SQL)).length === 0);
        for (const r of r2.ok) await http.call(tokens.reporter, "POST", `/payout-requests/${r.body.id}/cancel`, { body: {} });
        check("the refused requests left no row", Number((await f.one(`SELECT count(*) AS n FROM payout_requests WHERE user_id = $1 AND state = 'requested'`, [(await http.get(tokens.reporter, "/auth/me")).body.user_id])).n) === 0);
        metrics.round1_accepted = r1.ok.length; metrics.round2_accepted = r2.ok.length;
      }
    }
  } catch (e) {
    fails.push(`aborted: ${String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 300)}`); console.error(e.stack ?? e);
  } finally { await db.end(); }
  const failed = fails.length > 0;
  Object.assign(metrics, { checks, checks_failed: fails.length, deferred_checks: deferred.length });
  finish(doc, failed ? "fail" : "partial", metrics, failed ? fails.join("؛ ") :
    `طلبات صرف متزامنة فوق المتاح لا تُقبل إلا بقدر المتاح: خمسة طلبات بـ2000 معًا ثم طلبان بـ4000 معًا على رصيد محرَّر من بيعة تجريبية؛ القبول بالعدد المتوقع بالضبط، والباقي 422 بلا صف، و«قيد الصرف» و«المتاح» يجمعان الرصيد كاملًا، ولا حساب مستحق مدين.${deferred.length ? ` لم يُقَس لأن الخادم لا يقدّمه بعد: ${deferred.join("؛ ")}.` : ""} جزئية دائمًا: مزوّد وقناة تجريبيان، ومراسل واحد، وتشغيل واحد.`);
  const dir = env.ACCEPTANCE_RESULTS_DIR ? undefined : join(ROOT, "docs/measurements/commerce");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "sandbox", ...(dir ? { dir } : {}) }));
  return { code: failed ? 1 : 0, doc };
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
