// Turns a filled field-sheet card into a measurement.json result under docs/measurements/acceptance/.
//   node tools/acceptance/field/record-card.mjs <card.json> [--dry-run]
// Cards: task-killers, force-quit-restart, timestamp-alignment (see cards.mjs and the matching .md sheet).
import { readFileSync } from "node:fs";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";
import { scan, CHANNEL_KEYS } from "../lib/pii.mjs";
import { RULES } from "./cards.mjs";

export function cardToResult(card) {
  const rule = RULES[card.test_name];
  if (!rule) return { missing: [`test_name must be one of ${Object.keys(RULES).join(", ")}`] };
  const missing = rule.validate(card);
  // the sheet forbids revealing data in free text; the check is mechanical so a slip is refused, not recorded
  const leaks = scan(card, { keys: CHANNEL_KEYS });
  if (leaks.length) missing.push(`revealing data in card: ${leaks.map((l) => `${l.kind}@${l.path}`).join(", ")}`);
  if (missing.length) return { missing };

  const j = rule.judge(card);
  const doc = newResult(card.test_name, {
    role: "field-supervisor",
    device: card.device ? { platform: j.platform, model: [card.device.vendor, card.device.model].filter(Boolean).join(" "), ...(card.device.os_version ? { os_version: card.device.os_version } : {}), ...(card.device.free_storage_mb ? { free_storage_mb: card.device.free_storage_mb } : {}) } : { platform: j.platform },
    network: j.network,
    upload_path: j.upload_path,
    ...(Object.keys(j.file).length ? { file: j.file } : {}),
  });
  doc.started_at = `${card.performed_on}T00:00:00Z`;
  const result = j.reasons.length ? "fail" : j.passIsFull ? "pass" : "partial";
  finish(doc, result, j.metrics, [j.reasons.length ? `فشل: ${j.reasons.join("؛ ")}` : j.okNote, card.observations || null].filter(Boolean).join("؛ "));
  doc.ended_at = `${card.performed_on}T23:59:59Z`; // the sheet records a day, not instants
  return { doc, slug: rule.slug(card) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args._[0]) { console.error("usage: record-card.mjs <card.json> [--dry-run]"); process.exit(2); }
  const { doc, slug, missing } = cardToResult(JSON.parse(readFileSync(args._[0], "utf8")));
  if (missing) { console.error("بطاقة غير مكتملة:\n  " + missing.join("\n  ")); process.exit(2); }
  console.log(doc.result === "fail" ? "FAIL" : "ok", doc.notes);
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug }));
}
