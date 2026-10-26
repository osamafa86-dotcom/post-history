import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ffmpegArgs, generateSyntheticVideo, plannedInterruptions, assessUpload, run,
} from "../scripts/upload-bench.mjs";

const upload = (extra = {}) => ({
  violations: [], interruptions: 1, resumeOffsets: [400], restartsFromZero: 0,
  bytesSent: 1200, patchCalls: 3, ...extra,
});
const facts = { wanted: 1, sizeBytes: 1000, chunkSize: 500, localSha256: "local", remoteSha256: "local" };

test("FFmpeg generation is capped and padded to the exact requested size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upload-bench-test-"));
  const path = join(dir, "clip.mp4");
  try {
    let received;
    const result = await generateSyntheticVideo(path, 1024, {
      exec(binary, args) { received = { binary, args }; writeFileSync(path, Buffer.alloc(128, 7)); },
    });
    assert.equal(readFileSync(path).length, 1024);
    assert.equal(result.paddingBytes, 896);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(received.binary, "ffmpeg");
    assert.equal(received.args.at(-1), path);
    assert.equal(received.args[received.args.indexOf("-fs") + 1], "1024");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FFmpeg arguments use only synthetic sources and no network input", () => {
  const args = ffmpegArgs("out.mp4", 100 * 1024 * 1024);
  assert.match(args[args.indexOf("-i") + 1], /^nullsrc=/);
  assert.ok(args.includes("libx264"));
  assert.equal(args.filter((value) => value === "-i").length, 1);
});

test("interruption points are unique, ordered, and inside the file", () => {
  const points = plannedInterruptions(10_000, 1_000, 3);
  assert.equal(points.length, 3);
  assert.ok(points.every((point, index) => point > 0 && point < 10_000 && (!index || point > points[index - 1])));
  assert.throws(() => plannedInterruptions(10_000, 1_000, 0), /positive integer/);
});

test("a resumed upload with matching streaming hash passes assessment", () => {
  const result = assessUpload(upload(), facts);
  assert.deepEqual(result.problems, []);
  assert.equal(result.resumeSucceeded, true);
  assert.equal(result.resent, 200);
});

test("restart from zero, missing interruption, and hash mismatch are findings", () => {
  const result = assessUpload(upload({ interruptions: 0, resumeOffsets: [0], restartsFromZero: 1 }), {
    ...facts, remoteSha256: "different",
  });
  assert.equal(result.resumeSucceeded, false);
  assert.equal(result.problems.length, 4);
  assert.ok(result.problems.some((problem) => problem.includes("SHA-256")));
});

test("re-sent data beyond the interrupted chunk budget is rejected", () => {
  const result = assessUpload(upload({ bytesSent: 1600 }), facts);
  assert.equal(result.resent, 600);
  assert.ok(result.problems.some((problem) => problem.includes("chunk budget")));
});

test("dry run neither requires an endpoint nor writes a measurement", async () => {
  const outcome = await run(["--dry-run"], {});
  assert.deepEqual(outcome, { code: 0, doc: null });
});
