// task-killers needs two physical phones (Xiaomi, Samsung) and a person: see field/task-killers.md.
// This entry point only prints the criterion and the instructions; results come from
// `node field/record-card.mjs <card.json>` once the supervisor has filled the card.
import { banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { EXIT_PENDING } from "../lib/pending.mjs";

export async function run() {
  banner(byName("task-killers"));
  console.log("FIELD: اتبع tools/acceptance/field/task-killers.md ثم سجّل البطاقة بـ field/record-card.mjs. لا نتيجة تُكتب من هنا.");
  return { code: EXIT_PENDING, doc: null };
}
