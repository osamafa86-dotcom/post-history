// ai-eval: the plan row asks for an evaluation on the 100-item set: no gross factual distortion, the refusal rate per provider on the
// shocking sample, the share of invented names, human correction time and cost per minute, and a refused item moving to the non-cloud
// path by itself. No such evaluation can be produced from here (the set needs real field recordings and a human judge), so this script
// does the one thing that can be checked: for each of the five parts it says whether a recorded result carries the evidence, and from
// which file. It reads docs/measurements only; it sends nothing anywhere and opens no recording.
// Evidence keys a result must carry (metrics), so that the AI worker's evaluation lands here without a change to this script:
//   gross_factual_errors (count, with `items_judged`), refusal_rate_pct__<provider> (one per provider, on the shocking sample),
//   entities_invented + entities_in_ref (asr-bench already writes both), human_correction_s_per_audio_min and cost_per_audio_min_usd,
//   refused_to_local_pct (share of refused items that took the non-cloud path without a person).
// ALWAYS `partial` while any part has no evidence; `pass` needs all five from the 100-item set (`items_judged >= 100`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";

const PARTS = [
  ["factual-distortion", (m) => typeof m.gross_factual_errors === "number" && m.items_judged >= 100],
  ["refusal-per-provider", (m) => Object.keys(m).some((k) => /^refusal_rate_pct__\w+/.test(k))],
  ["invented-names", (m) => m.entities_in_ref > 0 && typeof m.entities_invented === "number"],
  ["human-correction-and-cost", (m) => typeof m.human_correction_s_per_audio_min === "number" && typeof m.cost_per_audio_min_usd === "number"],
  ["refusal-routes-local", (m) => typeof m.refused_to_local_pct === "number"],
];

function* jsonFiles(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* jsonFiles(p);
    else if (e.endsWith(".json")) yield p;
  }
}

/** For each part: the files that carry its evidence (relative paths). `docs` = the measurements root. */
export function evidence(docs = join(ROOT, "docs/measurements")) {
  const found = Object.fromEntries(PARTS.map(([n]) => [n, []]));
  for (const f of jsonFiles(docs)) {
    let d; try { d = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    if (!d?.metrics) continue;
    for (const [name, has] of PARTS) if (has(d.metrics)) found[name].push(relative(docs, f));
  }
  return found;
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("ai-eval"));
  const found = evidence(deps.docs ?? env.AI_EVAL_DOCS ?? join(ROOT, "docs/measurements"));
  const doc = newResult("ai-eval", { device: { platform: "server" }, upload_path: "n/a" });
  const have = PARTS.filter(([n]) => found[n].length).map(([n]) => n), missing = PARTS.filter(([n]) => !found[n].length).map(([n]) => n);
  for (const [n] of PARTS) console.log(`${found[n].length ? "ok  " : "MISS"} ${n}${found[n].length ? `: ${found[n].slice(0, 2).join(", ")}` : ""}`);
  const metrics = { parts: PARTS.length, parts_with_evidence: have.length, parts_missing: missing.length };
  finish(doc, "partial", metrics,
    `تغطية الأدلة لا تقييم: ${have.length} من ${PARTS.length} أجزاء لها دليل مسجَّل في docs/measurements؛ الناقص: ${missing.join("، ") || "لا شيء"}. التقييم نفسه على مجموعة الـ100 مادة بحكم بشري لم يُجرَ، ولا pass قبله. لا يقرأ هذا السكربت تسجيلًا ولا يرسل شيئًا.`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "evidence" }));
  return { code: 0, doc, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
