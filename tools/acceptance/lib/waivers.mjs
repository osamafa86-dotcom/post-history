import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A waiver records a finding that is real but already raised with its owner. It keeps CI green, caps the
// result at "partial" (never "pass") and goes stale, failing the run, the moment the finding disappears.
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../waivers");

export function loadWaivers(testName) {
  const f = join(DIR, `${testName}.json`);
  const list = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  for (const w of list) for (const k of ["source", "path", "kind", "reason", "raised_to"]) if (!w[k]) throw new Error(`waiver in ${f} lacks "${k}"`);
  const same = (w, x) => w.source === x.source && w.path === x.path && w.kind === x.kind;
  return {
    list,
    isWaived: (x) => list.some((w) => same(w, x)),
    stale: (all) => list.filter((w) => !all.some((x) => same(w, x))),
  };
}
