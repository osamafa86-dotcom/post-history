// Turns a filled field-sheet card into a measurement.json result under docs/measurements/acceptance/.
//   node tools/acceptance/field/record-card.mjs <card.json> [--dry-run]
import { readFileSync } from "node:fs";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";
import { scan, CHANNEL_KEYS } from "../lib/pii.mjs";

const REQUIRED_STEPS = ["onboarding_completed", "battery_percent_at_start", "locked_minutes", "interventions_before_complete", "completed"];

export function cardToResult(card) {
  const missing = [];
  if (card.card_version !== 1) missing.push("card_version must be 1");
  if (card.test_name !== "task-killers") missing.push("test_name must be task-killers");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(card.performed_on ?? "")) missing.push("performed_on");
  if (!["xiaomi", "samsung"].includes(card.device?.vendor)) missing.push("device.vendor (xiaomi|samsung)");
  for (const k of ["model", "os_version"]) if (!card.device?.[k]) missing.push(`device.${k}`);
  if (!card.app_version) missing.push("app_version");
  if (!/^[0-9a-f]{64}$/.test(card.upload?.file_sha256 ?? "")) missing.push("upload.file_sha256");
  for (const k of REQUIRED_STEPS) if (card.steps?.[k] === null || card.steps?.[k] === undefined) missing.push(`steps.${k}`);
  if (card.steps?.completed === true && card.steps?.server_sha256_match == null) missing.push("steps.server_sha256_match (required once the upload completed)");
  const leaks = scan(card, { keys: CHANNEL_KEYS });
  if (leaks.length) missing.push(`revealing data in card: ${leaks.map((l) => `${l.kind}@${l.path}`).join(", ")}`);
  if (missing.length) return { missing };

  const s = card.steps;
  const reasons = [];
  if (!s.onboarding_completed) reasons.push("onboarding not completed");
  if (s.locked_minutes < 30) reasons.push(`locked only ${s.locked_minutes} min`);
  if (s.interventions_before_complete > 0) reasons.push(`${s.interventions_before_complete} intervention(s) before completion`);
  if (!s.completed) reasons.push("upload did not complete");
  else if (s.server_sha256_match !== true) reasons.push("server SHA-256 differs");

  const doc = newResult("task-killers", {
    role: "field-supervisor",
    device: { platform: "android", model: `${card.device.vendor} ${card.device.model}`, os_version: card.device.os_version, ...(card.device.free_storage_mb ? { free_storage_mb: card.device.free_storage_mb } : {}) },
    network: { profile: card.network?.type ?? "field" },
    upload_path: card.upload.path ?? "tusd",
    file: { size_bytes: card.upload.file_size_bytes ?? 1073741824 },
  });
  doc.started_at = `${card.performed_on}T00:00:00Z`;
  finish(doc, reasons.length ? "fail" : "partial", {
    vendor: card.device.vendor,
    app_version: card.app_version,
    locked_minutes: s.locked_minutes,
    interventions_before_complete: s.interventions_before_complete,
    completed: s.completed,
    completed_minutes_after_start: s.completed_minutes_after_start ?? "n/a",
    sha256_match: s.server_sha256_match ?? "n/a",
    battery_percent_at_start: s.battery_percent_at_start,
  }, [reasons.length ? `فشل: ${reasons.join("؛ ")}` : "نجح هذا الجهاز؛ المعيار يعبر حين تنجح بطاقتا Xiaomi وSamsung معًا، فهذه النتيجة جزئية للمعيار", card.observations || null].filter(Boolean).join("؛ "));
  doc.ended_at = `${card.performed_on}T23:59:59Z`; // the sheet records a day, not instants
  return { doc };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args._[0]) { console.error("usage: record-card.mjs <card.json> [--dry-run]"); process.exit(2); }
  const { doc, missing } = cardToResult(JSON.parse(readFileSync(args._[0], "utf8")));
  if (missing) { console.error("بطاقة غير مكتملة:\n  " + missing.join("\n  ")); process.exit(2); }
  console.log(doc.result === "fail" ? "FAIL" : "ok", doc.notes);
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: doc.metrics.vendor }));
}
