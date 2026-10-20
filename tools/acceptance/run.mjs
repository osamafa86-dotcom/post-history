#!/usr/bin/env node
// Acceptance runner: one script per row of the acceptance table.
//   node run.mjs --list
//   node run.mjs pii-leak tenant-isolation [--dry-run]     run named tests (results go to docs/measurements/acceptance/)
//   node run.mjs all --dry-run                               every test; pending ones are reported, not failed
// Exit: 0 all ran ok (or pending), 1 a criterion failed, 2 an environment was unreachable and nothing was measured.
import { CATALOG, EXTRA, byName } from "./lib/catalog.mjs";
import { EXIT_PENDING } from "./lib/pending.mjs";
import { parseArgs } from "./lib/measurement.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.list) {
  for (const t of [...CATALOG, ...EXTRA]) console.log(`${t.name.padEnd(24)} ${t.mode.padEnd(10)} ${t.criterion}`);
  process.exit(0);
}
const wanted = args._.includes("all") || !args._.length ? CATALOG.map((t) => t.name) : args._;
const unknown = wanted.filter((n) => !byName(n));
if (unknown.length) { console.error(`unknown test(s): ${unknown.join(", ")} (see --list)`); process.exit(2); }

const passthrough = args["dry-run"] ? ["--dry-run"] : [];
const summary = [];
let worst = 0;
for (const name of wanted) {
  const mod = await import(`./scripts/${name}.mjs`);
  let outcome;
  try {
    const { code, doc } = await mod.run(passthrough);
    outcome = code === EXIT_PENDING ? "pending" : code === 2 ? "environment" : code ? "FAIL" : doc?.result ?? "ok";
    if (code !== EXIT_PENDING) worst = Math.max(worst, code);
  } catch (e) {
    console.error(`${name}: ${e.stack ?? e}`);
    outcome = "ERROR"; worst = Math.max(worst, 1);
  }
  summary.push([name, outcome]);
}
console.log("\n== summary");
for (const [n, o] of summary) console.log(`${n.padEnd(24)} ${o}`);
process.exit(worst);
