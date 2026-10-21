// optimistic-concurrency (core gate): two concurrent edits carrying the same If-Match -> one 200 and one 412 precondition_failed, no lost update.
//   OCC_API_URL  OCC_TOKENS {reporter, supervisor}  OCC_ROUNDS (20)
// Per round: GET gives the ETag; two PATCHes with that ETag race; exactly one wins, the other is 412 with no trace (its title never appears, the
// ETag moved once); a stale ETag is refused on a PATCH and on a transition (state unchanged), the fresh ETag is accepted, and a write
// without If-Match still works (v0 clients). `pass` needs 20 rounds. Not measured: races across several API processes.
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, materialBody } from "../lib/live.mjs";
import { checker, etagOf, gateOff } from "../lib/core-gate.mjs";
import { freshFetch } from "../lib/http.mjs";

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("optimistic-concurrency"));
  const off = gateOff("optimistic-concurrency", env);
  if (off) return off;
  if (!env.OCC_API_URL) { console.error("ENVIRONMENT: OCC_API_URL is not set; nothing measured"); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.OCC_TOKENS ?? "{}");
  const http = client(env.OCC_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("optimistic-concurrency", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const rounds = Number(env.OCC_ROUNDS ?? 20);
  const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
  const n = { oneWinner: 0, loserClean: 0, etagMovedOnce: 0, staleRefused: 0, transitionRefused: 0, freshAccepted: 0, noHeaderOk: 0 };
  const patch = (id, title, etag) => http.call(tokens.reporter, "PATCH", `/materials/${id}`, { body: { title }, headers: etag ? { "if-match": etag } : {} });
  for (let i = 0; i < rounds; i++) {
    const tag = `occ-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const m = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `${tag}-base`) })).body;
    const g = await http.get(tokens.reporter, `/materials/${m.id}`);
    const etag = etagOf(g);
    if (!/^"\d+"$/.test(etag ?? "")) { console.log(`round ${i}: GET returned no usable ETag (${etag})`); continue; }
    const [a, b] = await Promise.all([patch(m.id, `${tag}-A`, etag), patch(m.id, `${tag}-B`, etag)]);
    const codes = [a.status, b.status].sort();
    const win = a.status === 200 ? { r: a, t: `${tag}-A` } : { r: b, t: `${tag}-B` };
    const lose = a.status === 200 ? { r: b, t: `${tag}-B` } : { r: a, t: `${tag}-A` };
    if (codes[0] === 200 && codes[1] === 412 && lose.r.body?.code === "precondition_failed") n.oneWinner++; else console.log(`round ${i}: statuses ${codes.join(",")}`);
    const after = await http.get(tokens.reporter, `/materials/${m.id}`);
    if (after.body?.title === win.t && !JSON.stringify(after.body).includes(lose.t)) n.loserClean++;
    if (Number(etagOf(after)?.replace(/"/g, "")) === Number(etag.replace(/"/g, "")) + 1) n.etagMovedOnce++;
    const stale = await patch(m.id, `${tag}-stale`, etag);
    if (stale.status === 412 && (await http.get(tokens.reporter, `/materials/${m.id}`)).body?.title === win.t) n.staleRefused++;
    const tr = await http.call(tokens.supervisor, "POST", `/materials/${m.id}/transitions`, { body: { track: "editorial", to: "acknowledged", reason: "occ" }, headers: { "if-match": etag } });
    const still = (await http.get(tokens.reporter, `/materials/${m.id}`)).body?.editorial_state;
    if (tr.status === 412 && still === "inbox") n.transitionRefused++;
    const fresh = await http.call(tokens.supervisor, "POST", `/materials/${m.id}/transitions`, { body: { track: "editorial", to: "acknowledged", reason: "occ" }, headers: { "if-match": etagOf(after) } });
    if (fresh.status === 200) n.freshAccepted++;
    const bare = await patch(m.id, `${tag}-bare`, null);
    if (bare.status === 200) n.noHeaderOk++;
  }
  check(`${rounds} rounds: concurrent same-ETag edits give one 200 and one 412 precondition_failed`, rounds > 0 && n.oneWinner === rounds, `${n.oneWinner}/${rounds}`);
  check("no lost update: the stored title is the winner's and the loser's value is nowhere", n.loserClean === rounds, `${n.loserClean}/${rounds}`);
  check("the ETag moved exactly once per round", n.etagMovedOnce === rounds, `${n.etagMovedOnce}/${rounds}`);
  check("a stale ETag is refused on PATCH with no effect", n.staleRefused === rounds, `${n.staleRefused}/${rounds}`);
  check("a stale ETag is refused on a transition and the state is unchanged", n.transitionRefused === rounds, `${n.transitionRefused}/${rounds}`);
  check("the fresh ETag is accepted", n.freshAccepted === rounds, `${n.freshAccepted}/${rounds}`);
  check("a write without If-Match still works (v0 clients)", n.noHeaderOk === rounds, `${n.noHeaderOk}/${rounds}`);
  const full = rounds >= 20;
  finish(doc, fails.length ? "fail" : full ? "pass" : "partial", { rounds, ...n }, `${rounds} جولة بتعديلين متزامنين على ETag واحد؛ لم تُقَس السباقات عبر عمليات خادم متعددة${full ? "" : "؛ أقل من 20 جولة فلا pass"}`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
