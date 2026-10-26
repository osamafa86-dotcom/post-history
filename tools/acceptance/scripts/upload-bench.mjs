#!/usr/bin/env node
// upload-bench: synthetic FFmpeg uploads at 100 MiB, 500 MiB and 2 GiB with timed tus resume and client RSS sampling.
// Required: BENCH_TUS_ENDPOINT. Optional: BENCH_SIZES_MB=100,500,2048 BENCH_CHUNK_MB=8 BENCH_INTERRUPTIONS=1
// BENCH_TUS_HEADERS_JSON supplies account/auth headers; BENCH_WORK_DIR and BENCH_FFMPEG select local paths.
// Hash the stored object through BENCH_S3_ENDPOINT/BENCH_S3_ACCESS_KEY/BENCH_S3_SECRET_KEY/BENCH_S3_BUCKET
// [BENCH_S3_REGION BENCH_S3_PREFIX], or stream it over GET when S3 is not configured. Nothing is buffered whole.
// Files are generated in a temporary directory and deleted; --dry-run prints the plan without generating or uploading.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { s3FromEnv, tusObjectKey } from "../lib/s3.mjs";

const MiB = 1024 * 1024;
const NETWORK_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function ffmpegArgs(path, sizeBytes) {
  // Eight megabits per second makes the duration deterministic; -fs caps the container before exact padding.
  const seconds = Math.max(1, Math.ceil((sizeBytes * 8) / 8_000_000));
  const source = `nullsrc=size=160x90:rate=2:duration=${seconds},noise=alls=100:allf=t+u`;
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", source,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-b:v", "8M", "-minrate", "8M", "-maxrate", "8M", "-bufsize", "16M",
    "-an", "-fs", String(sizeBytes), path];
}

export async function generateSyntheticVideo(path, sizeBytes, {
  ffmpeg = "ffmpeg", exec = execFileSync, stat = statSync, truncate = truncateSync,
} = {}) {
  const started = performance.now();
  exec(ffmpeg, ffmpegArgs(path, sizeBytes), { stdio: ["ignore", "ignore", "pipe"] });
  const encodedBytes = stat(path).size;
  if (encodedBytes > sizeBytes) throw new Error(`FFmpeg exceeded requested size: ${encodedBytes} > ${sizeBytes}`);
  // Trailing zero padding keeps the MP4 readable while making the benchmark sizes exact and reproducible.
  if (encodedBytes < sizeBytes) truncate(path, sizeBytes);
  return { sha256: await sha256File(path), generationMs: performance.now() - started, paddingBytes: sizeBytes - encodedBytes };
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
    input.on("error", reject);
  });
}

export function plannedInterruptions(sizeBytes, chunkSize, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error("BENCH_INTERRUPTIONS must be a positive integer");
  return Array.from({ length: count }, (_, index) => {
    const point = Math.floor((sizeBytes * (index + 1)) / (count + 1));
    return Math.min(sizeBytes - 2, point + Math.max(1, Math.floor(chunkSize / 3)));
  });
}

export function assessUpload(upload, { wanted, sizeBytes, chunkSize, localSha256, remoteSha256 }) {
  const problems = [...upload.violations];
  if (upload.interruptions !== wanted) problems.push(`completed ${upload.interruptions}/${wanted} planned interruptions`);
  if (upload.resumeOffsets.length !== wanted) problems.push(`observed ${upload.resumeOffsets.length}/${wanted} resume offsets`);
  if (upload.resumeOffsets.some((offset) => offset <= 0 || offset >= sizeBytes)) problems.push("a resume offset was zero, complete, or outside the file");
  if (upload.restartsFromZero) problems.push(`${upload.restartsFromZero} resume(s) restarted from zero`);
  const resent = Math.max(0, upload.bytesSent - sizeBytes);
  if (resent > wanted * chunkSize) problems.push("re-sent bytes exceeded the interrupted chunk budget");
  const resumeSucceeded = problems.length === 0;
  if (remoteSha256 && remoteSha256 !== localSha256) problems.push("stored SHA-256 differs from the generated file");
  return { problems, resent, resumeSucceeded };
}

export function rssSampler(intervalMs = 50) {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); peak = Math.max(peak, process.memoryUsage().rss); return peak; };
}

async function streamHttpSha256(location, headers) {
  const response = await fetch(location, { headers: { "Tus-Resumable": "1.0.0", ...headers } });
  if (response.status !== 200 || !response.body) return { sha256: null, status: response.status };
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return { sha256: hash.digest("hex"), status: response.status };
}

function headersFromEnv(env) {
  const parsed = JSON.parse(env.BENCH_TUS_HEADERS_JSON ?? "{}");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((v) => typeof v !== "string")) {
    throw new Error("BENCH_TUS_HEADERS_JSON must be a JSON object of string headers");
  }
  return parsed;
}

async function runOne(sizeMb, { env, workDir, headers, s3 }) {
  const sizeBytes = sizeMb * MiB;
  const chunkSize = Number(env.BENCH_CHUNK_MB ?? 8) * MiB;
  const wanted = Number(env.BENCH_INTERRUPTIONS ?? 1);
  const doc = newResult("upload-bench", {
    device: { platform: "server" },
    network: { profile: env.BENCH_NETWORK_PROFILE ?? "local" },
    upload_path: "tusd",
    file: { size_bytes: sizeBytes, codec: "h264", vfr: false, hdr: false },
  });
  const path = join(workDir, `synthetic-${sizeMb}mb.mp4`);
  const generated = await generateSyntheticVideo(path, sizeBytes, { ffmpeg: env.BENCH_FFMPEG ?? "ffmpeg" });
  const uploadStarted = performance.now();
  const stopSampling = rssSampler(Number(env.BENCH_RSS_SAMPLE_MS ?? 50));
  let upload;
  let uploadRssPeak;
  try {
    upload = await resumableUpload({
      endpoint: env.BENCH_TUS_ENDPOINT, file: path, size: sizeBytes, chunkSize,
      interruptAt: plannedInterruptions(sizeBytes, chunkSize, wanted), headers,
      metadata: { filename: `synthetic-${sizeMb}mb.mp4`, acceptance: "upload-bench" },
    });
  } finally {
    upload?.agentClose();
    uploadRssPeak = stopSampling();
  }
  const uploadMs = performance.now() - uploadStarted;
  const hashStarted = performance.now();
  let remote;
  let hashSource;
  if (s3) {
    const bucket = env.BENCH_S3_BUCKET;
    if (!bucket) throw new Error("BENCH_S3_BUCKET is required with BENCH_S3_* credentials");
    remote = { sha256: await s3.sha256(bucket, tusObjectKey(env.BENCH_S3_PREFIX ?? "", upload.location)), status: "s3" };
    hashSource = "s3-stream";
  } else {
    remote = await streamHttpSha256(upload.location, headers);
    hashSource = "http-stream";
  }
  const hashMs = performance.now() - hashStarted;
  const { problems, resent, resumeSucceeded } = assessUpload(upload, {
    wanted, sizeBytes, chunkSize, localSha256: generated.sha256, remoteSha256: remote.sha256,
  });
  const verified = Boolean(remote.sha256);
  const metrics = {
    generation_time_s: Number((generated.generationMs / 1000).toFixed(3)),
    ffmpeg_padding_bytes: generated.paddingBytes,
    upload_time_s: Number((uploadMs / 1000).toFixed(3)),
    hash_time_s: Number((hashMs / 1000).toFixed(3)),
    total_time_s: Number(((generated.generationMs + uploadMs + hashMs) / 1000).toFixed(3)),
    throughput_mib_s: Number((sizeMb / (uploadMs / 1000)).toFixed(3)),
    upload_rss_peak_bytes: uploadRssPeak,
    process_max_rss_bytes: process.resourceUsage().maxRSS() * 1024,
    chunk_size_bytes: chunkSize,
    interruptions: upload.interruptions,
    resume_count: upload.resumeOffsets.length,
    resume_succeeded: resumeSucceeded,
    restarts_from_zero: upload.restartsFromZero,
    bytes_sent: upload.bytesSent,
    bytes_resent: resent,
    patch_calls: upload.patchCalls,
    sha256_match: verified ? remote.sha256 === generated.sha256 : "unverified",
    hash_source: hashSource,
    protocol_violations: upload.violations.length,
  };
  finish(doc, problems.length ? "fail" : verified ? "pass" : "partial", metrics,
    ["ملف اصطناعي مولّد وقت التشغيل وحُذف بعد القياس؛ الذاكرة المعروضة لعملية العميل لا لخادم tusd",
      verified ? null : `تعذر التحقق من البصمة عبر ${hashSource} (HTTP ${remote.status})`,
      problems.length ? problems.join("؛ ") : null].filter(Boolean).join("؛ "));
  return { doc, code: problems.length ? 1 : 0 };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const sizes = (env.BENCH_SIZES_MB ?? "100,500,2048").split(",").map(Number);
  if (!sizes.length || sizes.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error("BENCH_SIZES_MB must be comma-separated positive integers");
  console.log(`قياس الرفع والاستئناف: ${sizes.join(", ")} ميغابايت؛ توليد FFmpeg اصطناعي وحذف الملفات بعد التشغيل.`);
  if (args["dry-run"]) return { code: 0, doc: null };
  if (!env.BENCH_TUS_ENDPOINT) {
    console.error("ENVIRONMENT: BENCH_TUS_ENDPOINT is required; nothing was measured");
    return { code: 2, doc: null };
  }
  const headers = headersFromEnv(env);
  const s3 = s3FromEnv(env, "BENCH_S3");
  const workDir = mkdtempSync(join(env.BENCH_WORK_DIR ?? tmpdir(), "upload-bench-"));
  const docs = [];
  let worst = 0;
  try {
    for (const sizeMb of sizes) {
      try {
        const outcome = await runOne(sizeMb, { env, workDir, headers, s3 });
        docs.push(outcome.doc);
        worst = Math.max(worst, outcome.code);
        const file = writeResult(outcome.doc, { slug: `${sizeMb}mb` });
        console.log(`${sizeMb} MiB: ${outcome.doc.result}; wrote ${file}`);
      } catch (error) {
        if (error.code && NETWORK_ERRORS.has(error.code) && !docs.length) {
          console.error(`ENVIRONMENT: tus endpoint unreachable (${error.code}); nothing was measured`);
          return { code: 2, doc: null };
        }
        throw error;
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return { code: worst, doc: docs.at(-1) ?? null };
}
