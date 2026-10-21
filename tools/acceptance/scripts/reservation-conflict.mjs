// reservation-conflict (core gate): concurrent reservations of one material by different users -> exactly one succeeds.
//   RESERVE_API_URL  RESERVE_TOKENS {reporter, supervisor, producer, producer_b, editor_in_chief, system_admin}  RESERVE_ROUNDS (20)
// Each round makes a fresh accepted material and fires one POST /materials/{id}/reservation per contender at once.
// Correct: one 200, every other 409 already_reserved; the material shows that winner in `in_production`; exactly one
// `material.reserved` event; replaying the winner's Idempotency-Key answers 200 with the same reservation and adds no event.
// `pass` needs at least 20 rounds and three contenders; below that it is partial. Not measured: contention across several API processes.
import { randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, eventsOfType } from "../lib/live.mjs";
import { acceptedMaterial, checker, gateOff } from "../lib/core-gate.mjs";
import { freshFetch } from "../lib/http.mjs";

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("reservation-conflict"));
  const off = gateOff("reservation-conflict", env);
  if (off) return off;
  if (!env.RESERVE_API_URL) { console.error("ENVIRONMENT: RESERVE_API_URL is not set; nothing measured"); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.RESERVE_TOKENS ?? "{}");
  const http = client(env.RESERVE_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("reservation-conflict", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const contenders = ["producer", "producer_b", "editor_in_chief"].filter((r) => tokens[r]);
  const rounds = Number(env.RESERVE_ROUNDS ?? 20);
  const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
  let exactlyOne = 0, wrongLoser = 0, stateWrong = 0, replayWrong = 0;
  const winners = new Map();
  for (let i = 0; i < rounds; i++) {
    const id = await acceptedMaterial(http, tokens, fv, `reserve-${i}`);
    const keys = contenders.map(() => randomUUID());
    const res = await Promise.all(contenders.map((r, k) => http.call(tokens[r], "POST", `/materials/${id}/reservation`, { key: keys[k] })));
    const won = res.map((r, k) => ({ r, k })).filter((x) => x.r.status === 200);
    const lost = res.filter((r) => r.status === 409 && r.body?.code === "already_reserved");
    if (won.length === 1 && lost.length === contenders.length - 1) exactlyOne++;
    else { wrongLoser++; console.log(`round ${i}: statuses ${res.map((r) => r.status).join(",")}`); }
    if (won.length !== 1) continue;
    winners.set(id, contenders[won[0].k]);
    const detail = (await http.get(tokens.reporter, `/materials/${id}`)).body;
    if (detail.editorial_state !== "in_production" || detail.reserved_by !== won[0].r.body.reserved_by) stateWrong++;
    const replay = await http.call(tokens[contenders[won[0].k]], "POST", `/materials/${id}/reservation`, { key: keys[won[0].k] });
    if (replay.status !== 200 || replay.body?.reserved_by !== won[0].r.body.reserved_by) replayWrong++;
  }
  check(`${rounds} rounds: exactly one reservation succeeds, the others get 409 already_reserved`, rounds > 0 && exactlyOne === rounds, `${exactlyOne}/${rounds}`);
  check("the material shows the winner and is in_production", stateWrong === 0, `${stateWrong} wrong`);
  check("replaying the winner's Idempotency-Key answers the same reservation", replayWrong === 0, `${replayWrong} wrong`);
  const events = tokens.system_admin ? await eventsOfType(http, tokens.system_admin, "material.reserved") : null;
  if (events) {
    const per = new Map();
    for (const e of events) if (winners.has(e.payload?.material_id)) per.set(e.payload.material_id, (per.get(e.payload.material_id) ?? 0) + 1);
    check("exactly one material.reserved event per material, replays included", [...winners.keys()].every((id) => per.get(id) === 1), `${[...per.values()].filter((n) => n !== 1).length} materials off`);
  }
  const full = rounds >= 20 && contenders.length >= 3 && Boolean(events);
  finish(doc, fails.length ? "fail" : full ? "pass" : "partial", {
    rounds, contenders: contenders.length, rounds_with_exactly_one_winner: exactlyOne, state_mismatches: stateWrong, replay_mismatches: replayWrong, events_checked: Boolean(events),
  }, `${rounds} جولة بـ${contenders.length} متنافسين متزامنين؛ لم يُقَس التنافس بين عمليات خادم متعددة${full ? "" : "؛ أقل من 20 جولة أو 3 متنافسين أو بلا قراءة الأحداث فلا pass"}`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
