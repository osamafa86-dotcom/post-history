import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidence, run } from "../scripts/ai-eval.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";

const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const put = (dir, name, metrics) => { mkdirSync(join(dir, "ai"), { recursive: true }); writeFileSync(join(dir, "ai", name), JSON.stringify({ metrics })); };

test("ai-eval reads which of the five parts a recorded result carries, and stays partial until all five come from 100 judged items", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-eval-"));
  try {
    put(dir, "a.json", { entities_in_ref: 40, entities_invented: 2 });
    put(dir, "b.json", { gross_factual_errors: 0, items_judged: 12 });
    const e = evidence(dir);
    assert.deepEqual(e["invented-names"], ["ai/a.json"]);
    assert.deepEqual(e["factual-distortion"], [], "12 judged items are not the 100-item set");
    const { doc, missing } = await quiet(() => run(["--dry-run"], {}, { docs: dir }));
    assert.equal(doc.result, "partial");
    assert.equal(doc.metrics.parts_with_evidence, 1);
    assert.equal(missing.length, 4);
    assert.equal(validateMeasurement(doc).ok, true);
    put(dir, "c.json", { gross_factual_errors: 0, items_judged: 100, refusal_rate_pct__x: 3, human_correction_s_per_audio_min: 40, cost_per_audio_min_usd: 0.1, refused_to_local_pct: 100 });
    assert.equal((await quiet(() => run(["--dry-run"], {}, { docs: dir }))).doc.metrics.parts_with_evidence, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
