#!/usr/bin/env node
// refund-after-payout (ADR 0031/0033, plan row «الاسترداد»: after the payout): the reporter's whole share of a sale is released, requested, approved and paid out by the
// sandbox channel; the order is then refunded. The reversal must not push the reporter's payable accounts to the debit side: what can no longer be taken
// back from the reporter comes from `refund_reserve`, the money already paid stays paid, and the refund entry balances.
//   1. sale -> released to «available» -> the reporter requests everything he can -> finance approves (a reporter and a repeated approval are refused)
//   2. the sandbox channel finishes it (processing, then paid) and «in payout» empties into «paid»
//   3. finance refunds the order item, the signed refund notification arrives:
//        - one refund entry that balances; its `refund_reserve` posting equals the reporter's share the entry could not take from pending/available
//        - no contributor payable account is on the debit side; «paid» is unchanged
// `partial` always: sandbox provider and channel, one reporter, one run. Same environment as payout-concurrent; the server needs PAYOUT_RELEASE_AFTER_DAYS=0 and a short PAYOUT_WORKER_INTERVAL_MS.
import { join } from "node:path";
import pg from "pg";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client } from "../lib/live.mjs";
import { DEBIT_BALANCE_SQL, SALE_MINOR, fixtures, judgeDebitBalances, money } from "./payout-fixtures.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("refund-after-payout"));
  const need = ["SP_API_URL", "SP_ROOT_URL", "SP_DATABASE_URL", "SP_WEBHOOK_SECRET", "SP_TOKENS"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.SP_TOKENS);
  const http = client(env.SP_API_URL), db = new pg.Client({ connectionString: env.SP_DATABASE_URL });
  const doc = newResult("refund-after-payout", { device: { platform: "server", model: env.SP_ENV_LABEL ?? "server" }, upload_path: "n/a" });
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
      const s = await f.sale("refund-after");
      const reached = await f.untilAvailable(base0 + 7001n);
      check("the sale is released to «available» by the payout worker", reached !== null, "available never reached the reporter's share in 20 s");
      if (reached) {
        const amount = reached.available;
        const before = reached;
        const req = await f.requestPayout(amount);
        check("the reporter requests everything he can: 201, requested, one approval needed", req.status === 201 && req.body?.state === "requested" && req.body?.approvals_required === 1, `status ${req.status} ${req.text?.slice?.(0, 120)}`);
        const id = req.body?.id;
        const mid = await f.earnings();
        check("the amount moved at once from «available» to «in payout»", mid.available === 0n && mid.in_payout === before.in_payout + amount, `available ${mid.available}, in_payout ${mid.in_payout}`);
        check("a reporter cannot approve (403)", (await http.call(tokens.reporter, "POST", `/payout-requests/${id}/approve`, { body: {} })).status === 403);
        const appr = await http.call(tokens.finance, "POST", `/payout-requests/${id}/approve`, { body: {} });
        check("finance approves: 200 and approved (or already moved on by the channel)", appr.status === 200 && ["approved", "processing", "paid"].includes(appr.body?.state), `status ${appr.status} ${appr.body?.state}`);
        let state = appr.body?.state;
        for (let i = 0; i < 80 && state !== "paid"; i++) { await new Promise((r) => setTimeout(r, 250)); state = (await http.get(tokens.reporter, `/payout-requests/${id}`)).body?.state; }
        check("the sandbox channel finishes it: paid", state === "paid", `state ${state}`);
        const events = await f.q(`SELECT payload FROM outbox_events WHERE type = 'payout.status_changed' AND aggregate_id::text = $1 ORDER BY id`, [id]);
        const seen = events.map((r) => r.payload?.state).join(",");
        check("the request's events run requested, approved, processing, paid", seen === "requested,approved,processing,paid", seen);
        check("the events carry ids and codes only: no amount, no channel reference", events.every((r) => !/amount|channel|minor|sandbox_/i.test(JSON.stringify(r.payload))), JSON.stringify(events[0]?.payload));
        const paid = await f.earnings();
        check("«in payout» emptied into «paid» by exactly the amount", paid.in_payout === before.in_payout && paid.paid === before.paid + amount, `in_payout ${paid.in_payout}, paid ${paid.paid}`);
        // ---- the refund, after the money left ----
        const rf = await http.call(tokens.finance, "POST", `/orders/${s.orderId}/refunds`, { body: { order_item_ids: [s.itemId], reason_code: "buyer_request" } });
        check("finance refunds the order after the payout: 201 pending", rf.status === 201 && rf.body?.status === "pending", `status ${rf.status}`);
        const refundRef = (await f.one(`SELECT provider_refund_ref FROM refunds WHERE id = $1`, [rf.body?.id]))?.provider_refund_ref;
        check("the provider gave the refund its own reference", Boolean(refundRef));
        // a provider retries a 5xx answer; the retries are counted and shown, not hidden
        const signedNote = f.signed("refund.succeeded", refundRef ?? s.providerRef, SALE_MINOR);
        let note = await f.send(signedNote), retries = 0;
        while (note.status >= 500 && retries < 3) { retries++; await new Promise((ok) => setTimeout(ok, 300)); note = await f.send(signedNote); }
        metrics.refund_notification_retries = retries;
        check("the signed refund notification is accepted", note.status === 200, `status ${note.status}${retries ? ` after ${retries} retry(ies) of a 5xx` : ""}`);
        const entry = (await f.q(`SELECT id FROM journal_entries WHERE kind = 'refund' AND reference_type = 'order' AND reference_id = $1`, [s.orderId]));
        check("exactly one refund entry", entry.length === 1, `${entry.length}`);
        if (entry.length === 1) {
          const lines = await f.q(`SELECT a.kind, a.owner_id::text AS owner, a.payable_state AS state, p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id WHERE p.entry_id = $1`, [entry[0].id]);
          const sum = lines.reduce((t, l) => t + BigInt(l.amount), 0n);
          check("the refund entry balances", sum === 0n, `sum ${sum}`);
          const reserve = lines.filter((l) => l.kind === "refund_reserve").reduce((t, l) => t + BigInt(l.amount), 0n);
          const sale = await f.q(`SELECT p.amount_minor::text AS amount FROM postings p JOIN ledger_accounts a ON a.id = p.account_id JOIN journal_entries j ON j.id = p.entry_id WHERE j.kind = 'sale' AND j.reference_id = $1 AND a.kind = 'contributor_payable' AND a.owner_id = $2`, [s.orderId, s.reporterId]);
          const share = -sale.reduce((t, l) => t + BigInt(l.amount), 0n);
          const taken = lines.filter((l) => l.kind === "contributor_payable" && l.owner === s.reporterId).reduce((t, l) => t + BigInt(l.amount), 0n);
          check("what could not be taken back from the reporter came from the refund reserve, to the unit", reserve > 0n && reserve + taken === share, `reserve ${reserve}, taken ${taken}, share ${share}`);
          metrics.reporter_share_minor = Number(share); metrics.reserve_minor = Number(reserve);
        }
        check("no contributor payable account went to the debit side", judgeDebitBalances(await f.q(DEBIT_BALANCE_SQL)).length === 0, judgeDebitBalances(await f.q(DEBIT_BALANCE_SQL)).join("; "));
        const end = await f.earnings();
        check("the reporter's «paid» is unchanged and no balance is negative", end.paid === paid.paid && end.available >= 0n && end.pending >= 0n && end.in_payout >= 0n, `paid ${end.paid} vs ${paid.paid}`);
      }
    }
  } catch (e) {
    fails.push(`aborted: ${String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").replace(/Bearer\s+\S+/gi, "Bearer <redacted>").slice(0, 300)}`); console.error(e.stack ?? e);
  } finally { await db.end(); }
  const failed = fails.length > 0;
  Object.assign(metrics, { checks, checks_failed: fails.length, deferred_checks: deferred.length });
  finish(doc, failed ? "fail" : "partial", metrics, failed ? fails.join("؛ ") :
    `استرداد بعد الصرف: حصة المراسل من بيعة تجريبية تُحرَّر وتُطلب وتُعتمد وتُصرف بالقناة التجريبية (طلب، موافقة، معالجة، مصروف بأحداثها)، ثم يُسترد الطلب بإشعار موقّع: قيد استرداد واحد متوازن، وما لم يعد ممكنًا استرداده من المراسل جاء من احتياطي الاسترداد بالوحدة، و«المصروف» لا يتغيّر، ولا حساب مستحق مدين.${deferred.length ? ` لم يُقَس لأن الخادم لا يقدّمه بعد: ${deferred.join("؛ ")}.` : ""} جزئية دائمًا: مزوّد وقناة تجريبيان، ومراسل واحد، وتشغيل واحد.`);
  const dir = env.ACCEPTANCE_RESULTS_DIR ? undefined : join(ROOT, "docs/measurements/commerce");
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: "sandbox", ...(dir ? { dir } : {}) }));
  return { code: failed ? 1 : 0, doc };
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
