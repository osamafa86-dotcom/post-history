// Runs the shared cases through an implementation and reports each case's outcome.
//   node run.mjs                       reference implementation, checks forms against upload-form.json and cases against expectations
//   node run.mjs --out=web.json --platform=web   writes {platform, results} produced by `--impl=<module>` (default: reference)
//   node run.mjs --compare=web.json,ios.json,android.json   asserts every platform file agrees with expectations and with each other
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validate as reference } from "./reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

export function loadSuite() {
  const suite = read(join(HERE, "cases.json"));
  const forms = Object.fromEntries(Object.entries(suite.forms).map(([k, rel]) => [k, read(join(HERE, rel))]));
  return { suite, forms };
}

export function checkForms(forms) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const v = ajv.compile(read(join(HERE, "../../../contracts/schemas/upload-form.json")));
  return Object.entries(forms).filter(([, f]) => !v(f)).map(([k]) => `${k}: ${ajv.errorsText(v.errors)}`);
}

const norm = (r) => JSON.stringify({ valid: r.valid, errors: [...r.errors].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code)) });

export function judge(results, suite) {
  const wrong = [];
  for (const c of suite.cases) {
    const got = results[c.id];
    if (!got) wrong.push({ id: c.id, why: "no result" });
    else if (norm(got) !== norm(c.expect)) wrong.push({ id: c.id, why: `expected ${norm(c.expect)} got ${norm(got)}` });
  }
  return wrong;
}

export function runReference() {
  const { suite, forms } = loadSuite();
  const results = Object.fromEntries(suite.cases.map((c) => [c.id, reference(forms[c.form], c.material_type, c.values)]));
  return { suite, forms, results };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  const { suite, forms, results } = runReference();
  const formProblems = checkForms(forms);
  formProblems.forEach((p) => console.log(`FORM INVALID ${p}`));
  if (args.compare) {
    const files = args.compare.split(",");
    const per = files.map((f) => ({ f, ...read(f) }));
    let bad = 0;
    for (const p of per) {
      const wrong = judge(p.results, suite);
      wrong.forEach((w) => console.log(`${p.platform}: ${w.id}: ${w.why}`));
      console.log(`${p.platform}: ${suite.cases.length - wrong.length}/${suite.cases.length} cases match`);
      bad += wrong.length;
    }
    process.exit(bad || formProblems.length ? 1 : 0);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify({ platform: args.platform ?? "reference", results }, null, 1) + "\n");
  const wrong = judge(results, suite);
  wrong.forEach((w) => console.log(`${w.id}: ${w.why}`));
  console.log(`reference: ${suite.cases.length - wrong.length}/${suite.cases.length} cases match expectations; forms valid: ${formProblems.length === 0}`);
  process.exit(wrong.length || formProblems.length ? 1 : 0);
}
