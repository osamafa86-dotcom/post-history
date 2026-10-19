#!/usr/bin/env node
// CI gate on every measurement file in docs/measurements/: schema, naming, time order, honesty and no revealing data.
//   node tools/acceptance/validate-results.mjs [dir]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, validateMeasurement } from "./lib/measurement.mjs";
import { NAMES } from "./lib/catalog.mjs";
import { scan, CHANNEL_KEYS } from "./lib/pii.mjs";

const NAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*\.json$/;

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (e.endsWith(".json")) yield p;
  }
}

export function checkResult(path, doc) {
  const errs = [];
  const { ok, errors } = validateMeasurement(doc);
  if (!ok) errs.push(...errors.map((e) => `schema: ${e}`));
  if (!NAME.test(path.split("/").pop())) errs.push("name must be <YYYY-MM-DD>-<slug>.json");
  if (doc.started_at && doc.ended_at && Date.parse(doc.ended_at) < Date.parse(doc.started_at)) errs.push("ended_at precedes started_at");
  if (doc.tool === "acceptance") {
    if (!doc.test_name) errs.push("acceptance results must carry test_name");
    else if (!NAMES.includes(doc.test_name)) errs.push(`test_name "${doc.test_name}" is not a row of the acceptance table`);
  }
  // "pass" may not coexist with a metric that says the evidence is missing
  if (doc.result === "pass") {
    for (const [k, v] of Object.entries(doc.metrics ?? {})) {
      if (v === "unverified" || v === "n/a-unverified" || (k === "live_checked" && v === false)) errs.push(`result is pass but metric ${k}=${v}`);
    }
  }
  const { device, ...rest } = doc; // device.model is allowed by the results README; everything else is scanned
  const leaks = scan(rest, { keys: CHANNEL_KEYS });
  leaks.forEach((l) => errs.push(`revealing data (${l.kind}) at ${l.path}`));
  return errs;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const dir = process.argv[2] ?? join(ROOT, "docs/measurements");
  let n = 0, bad = 0;
  for (const f of files(dir)) {
    n++;
    let doc;
    try { doc = JSON.parse(readFileSync(f, "utf8")); } catch (e) { console.log(`FAIL ${relative(ROOT, f)}: not JSON`); bad++; continue; }
    const errs = checkResult(f, doc);
    if (errs.length) { bad++; console.log(`FAIL ${relative(ROOT, f)}\n  ${errs.join("\n  ")}`); }
  }
  console.log(`${n} result file(s) checked, ${bad} failing`);
  process.exit(bad ? 1 : 0);
}
