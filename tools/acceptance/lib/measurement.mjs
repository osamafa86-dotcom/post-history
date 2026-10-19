import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const RESULTS_DIR = join(ROOT, "docs/measurements/acceptance");

let validator;
export function measurementValidator() {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(ajv);
    validator = ajv.compile(JSON.parse(readFileSync(join(ROOT, "contracts/schemas/measurement.json"), "utf8")));
  }
  return validator;
}

export function validateMeasurement(doc) {
  const v = measurementValidator();
  const ok = v(doc);
  return { ok, errors: ok ? [] : v.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
}

/** Result envelope shared by every script; callers fill the rest of the schema fields. */
export function newResult(testName, extra = {}) {
  return {
    schema_version: 1,
    tool: "acceptance",
    role: "qa",
    test_name: testName,
    started_at: new Date().toISOString(),
    ended_at: null,
    result: "info",
    metrics: {},
    ...extra,
  };
}

export function finish(doc, result, metrics = {}, notes) {
  doc.ended_at = new Date().toISOString();
  doc.result = result;
  doc.metrics = { ...doc.metrics, ...metrics };
  if (notes) doc.notes = notes;
  return doc;
}

/** Validates then writes docs/measurements/acceptance/<date>-<test>-<slug>.json unless dryRun. */
export function writeResult(doc, { slug = "run", dir = RESULTS_DIR, dryRun = false } = {}) {
  const { ok, errors } = validateMeasurement(doc);
  if (!ok) throw new Error(`result for ${doc.test_name} does not match measurement.json:\n  ${errors.join("\n  ")}`);
  if (dryRun) return null;
  mkdirSync(dir, { recursive: true });
  // results are immutable: a repeated run gets a new file, never an overwrite
  const base = `${doc.started_at.slice(0, 10)}-${doc.test_name}-${slug}`;
  for (let n = 1; ; n++) {
    const file = join(dir, `${base}${n === 1 ? "" : `-${n}`}.json`);
    try {
      writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { flag: "wx" });
      return file;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

export function banner(test) {
  console.log(`\n== ${test.name}\nالمعيار: ${test.criterion}\n`);
}
