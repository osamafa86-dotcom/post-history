import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ffmpegArgs, fingerprintFile, generateSyntheticVideo, noiseInput, plannedInterruptions, assessUpload, runOne, run,
} from "../scripts/upload-bench.mjs";
import { validateMeasurement, writeResult } from "../lib/measurement.mjs";

const upload = (extra = {}) => ({
  violations: [], interruptions: 1, resumeOffsets: [400], restartsFromZero: 0,
  bytesSent: 1200, patchCalls: 3, ...extra,
});
const facts = { wanted: 1, sizeBytes: 1000, chunkSize: 500, localSha256: "local", remoteSha256: "local" };

test("FFmpeg generation records the actual encoded size without padding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upload-bench-test-"));
  const path = join(dir, "clip.mp4");
  try {
    let received;
    const result = await generateSyntheticVideo(path, 1024, {
      exec(binary, args) { received = { binary, args }; writeFileSync(path, Buffer.alloc(1000, 7)); },
    });
    assert.equal(readFileSync(path).length, 1000);
    assert.equal(result.encodedBytes, 1000);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.deflateRatio > 0 && result.deflateRatio <= 1);
    assert.equal(received.binary, "ffmpeg");
    assert.equal(received.args.at(-1), path);
    assert.equal(received.args[received.args.indexOf("-fs") + 1], "1024");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FFmpeg arguments use a high-entropy synthetic source and no network input", () => {
  const urandom = ffmpegArgs("out.mp4", 100 * 1024 * 1024, { source: "/dev/urandom" });
  assert.equal(urandom[urandom.indexOf("-i") + 1], "/dev/urandom");
  assert.ok(urandom.includes("rawvideo"));
  const lavfi = ffmpegArgs("out.mp4", 100 * 1024 * 1024, { source: null });
  assert.match(lavfi[lavfi.indexOf("-i") + 1], /^testsrc2=/);
  for (const args of [urandom, lavfi]) {
    assert.ok(args.includes("libx264"));
    assert.equal(args.filter((value) => value === "-i").length, 1);
  }
  assert.equal(noiseInput(() => { throw new Error("no urandom"); }), null);
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

test("runOne with injected stages writes a pass document that validates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upload-bench-test-"));
  try {
    const workDir = join(dir, "work");
    const resultsDir = join(dir, "results");
    mkdirSync(workDir);
    const sha = "a".repeat(64);
    const sizeBytes = 1024 * 1024;
    const { doc, code } = await runOne(1, {
      env: { BENCH_TUS_ENDPOINT: "http://tus.invalid/files", BENCH_NETWORK_PROFILE: "local" },
      workDir, headers: {}, s3: null,
      deps: {
        async generate(path) { writeFileSync(path, Buffer.alloc(sizeBytes, 7)); return { sha256: sha, generationMs: 5, encodedBytes: sizeBytes, deflateRatio: 0.99 }; },
        async uploadFile() {
          return { location: "http://tus.invalid/files/1", violations: [], interruptions: 1, resumeOffsets: [400], restartsFromZero: 0, bytesSent: sizeBytes + 200, patchCalls: 3, agentClose() {} };
        },
        async hashRemote() { return { sha256: sha, status: 200 }; },
      },
    });
    assert.equal(code, 0);
    assert.equal(doc.result, "pass");
    assert.equal(doc.file.size_bytes, sizeBytes);
    assert.equal(doc.network.profile, "local");
    assert.equal(typeof doc.metrics.process_max_rss_bytes, "number");
    assert.ok(doc.metrics.process_max_rss_bytes > 0);
    assert.equal(doc.metrics.content_fill_ratio, 1);
    const validation = validateMeasurement(doc);
    assert.deepEqual(validation.errors, []);
    const written = writeResult(doc, { slug: "injected", dir: resultsDir });
    assert.ok(existsSync(written));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runOne fails when the encoded content fills under 95% of the requested size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upload-bench-test-"));
  try {
    const workDir = join(dir, "work");
    mkdirSync(workDir);
    const sha = "b".repeat(64);
    const { doc, code } = await runOne(1, {
      env: { BENCH_TUS_ENDPOINT: "http://tus.invalid/files", BENCH_NETWORK_PROFILE: "local" },
      workDir, headers: {}, s3: null,
      deps: {
        async generate(path) { writeFileSync(path, Buffer.alloc(1024, 7)); return { sha256: sha, generationMs: 5, encodedBytes: 1024, deflateRatio: 0.1 }; },
        async uploadFile() {
          return { location: "http://tus.invalid/files/1", violations: [], interruptions: 1, resumeOffsets: [400], restartsFromZero: 0, bytesSent: 1200, patchCalls: 3, agentClose() {} };
        },
        async hashRemote() { return { sha256: sha, status: 200 }; },
      },
    });
    assert.equal(code, 1);
    assert.equal(doc.result, "fail");
    assert.match(doc.notes, /filled only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fingerprintFile pauses the input on backpressure instead of queuing the file in memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upload-bench-test-"));
  try {
    const path = join(dir, "blob.bin");
    const sizeBytes = 8 * 1024 * 1024;
    writeFileSync(path, randomBytes(sizeBytes));
    // مخزن كتابة بحد أقصى بايت واحد ومعالجة بطيئة: بلا ضغط راجع تصطف الملف كله في الذاكرة،
    // ومعه يبقى المصطفَّن دون قطعتين (64 KiB لكل قطعة قراءة).
    let maxBuffered = 0;
    const createDeflate = () => new Transform({
      writableHighWaterMark: 1,
      transform(chunk, encoding, callback) {
        maxBuffered = Math.max(maxBuffered, this.writableLength);
        setTimeout(callback, 1);
      },
    });
    const result = await fingerprintFile(path, { createDeflate });
    assert.equal(result.bytes, sizeBytes);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.ok(maxBuffered <= 2 * 64 * 1024, `deflate queue grew to ${maxBuffered} bytes; the input was not paused on backpressure`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const scriptPath = fileURLToPath(new URL("../scripts/upload-bench.mjs", import.meta.url));

test("the script runs from the shell: dry-run prints the plan and exits zero", () => {
  const outcome = spawnSync(process.execPath, [scriptPath, "--dry-run"], { encoding: "utf8" });
  assert.equal(outcome.status, 0, outcome.stderr);
  assert.match(outcome.stdout, /قياس الرفع/);
});

test("the script from the shell without an endpoint measures nothing and exits two", () => {
  const outcome = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(outcome.status, 2);
  assert.match(outcome.stderr, /BENCH_TUS_ENDPOINT/);
});

test("a run without a network profile measures nothing and exits two", async () => {
  const outcome = await run([], { BENCH_TUS_ENDPOINT: "http://tus.invalid/files" });
  assert.deepEqual(outcome, { code: 2, doc: null });
});

test("dry run neither requires an endpoint nor writes a measurement", async () => {
  const outcome = await run(["--dry-run"], {});
  assert.deepEqual(outcome, { code: 0, doc: null });
});
