import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStart, phoneProxy, synthClip } from "../lib/media-clips.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

test("a varied-audio clip and its phone light copy: the copy starts at zero, the original keeps its shifted start", { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), "clips-test-"));
  try {
    const orig = synthClip(join(dir, "o.mov"), { seconds: 6, size: "320x180", startOffset: 3.5, varied: true, tags: false });
    const prox = phoneProxy(orig, join(dir, "p.mp4"), { skipS: 1, seconds: 3 });
    assert.ok(statSync(orig).size > 1000 && statSync(prox).size > 1000);
    assert.ok(Math.abs(formatStart(orig) - 3.5) < 0.1, `original starts at ${formatStart(orig)}`);
    assert.ok(Math.abs(formatStart(prox)) < 0.1, `copy starts at ${formatStart(prox)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
