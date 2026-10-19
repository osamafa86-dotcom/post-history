// timestamp-alignment needs physical phones and a person: see field/timestamp-alignment.md.
// This entry point only prints the criterion and the instructions; results come from
// `node field/record-card.mjs <card.json>` once the card is filled.
import { banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { EXIT_PENDING } from "../lib/pending.mjs";

export async function run() {
  banner(byName("timestamp-alignment"));
  console.log("FIELD: اتبع tools/acceptance/field/timestamp-alignment.md ثم سجّل البطاقة بـ field/record-card.mjs. لا نتيجة تُكتب من هنا.");
  return { code: EXIT_PENDING, doc: null };
}
