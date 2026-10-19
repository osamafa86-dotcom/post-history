import { byName } from "./catalog.mjs";
import { banner } from "./measurement.mjs";

export const EXIT_PENDING = 3;

/** Placeholder for a row whose measured package does not exist yet. Prints the criterion, writes no result. */
export async function runPending(name) {
  const t = byName(name);
  banner(t);
  const where = t.mode === "field" ? "جهاز فعلي وإنسان: انظر field/" : "تنتظر الحزمة التي تقيسها";
  console.log(`PENDING: لم تُنفَّذ بعد (${where}). لا نتيجة تُكتب؛ «يعمل» بلا نتيجة لا يُقبل.`);
  return { code: EXIT_PENDING, doc: null };
}
