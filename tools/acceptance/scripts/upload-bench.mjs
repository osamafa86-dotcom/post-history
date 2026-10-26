#!/usr/bin/env node
// upload-bench: high-entropy synthetic h264 uploads at 100 MiB, 500 MiB and 2 GiB with timed tus resume and client RSS sampling.
// Required: BENCH_TUS_ENDPOINT and BENCH_NETWORK_PROFILE (the profile any published number belongs to, e.g. a netlab
// scenario or "field"; there is no default because a benchmark number without a declared profile is meaningless).
// Optional: BENCH_SIZES_MB=100,500,2048 BENCH_CHUNK_MB=8 BENCH_INTERRUPTIONS=1 BENCH_RSS_SAMPLE_MS=50
// BENCH_TUS_HEADERS_JSON supplies account/auth headers; BENCH_WORK_DIR and BENCH_FFMPEG select local paths.
// Hash the stored object through BENCH_S3_ENDPOINT/BENCH_S3_ACCESS_KEY/BENCH_S3_SECRET_KEY/BENCH_S3_BUCKET
// [BENCH_S3_REGION BENCH_S3_PREFIX], or stream it over GET when S3 is not configured. Nothing is buffered whole.
// The source is rawvideo noise read from /dev/urandom (testsrc2+noise lavfi fallback): the encoder saturates its rate
// cap, so the file is real content instead of trailing zeros. The actual encoded size is what gets uploaded and
// recorded, and the run fails when it fills under 95% of the requested target. Files are deleted after the run;
// --dry-run prints the plan without generating or uploading.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, createReadStream, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createGzip } from "node:zlib";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { s3FromEnv, tusObjectKey } from "../lib/s3.mjs";

const MiB = 1024 * 1024;
const NETWORK_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const BITRATE = 40_000_000;
const MIN_FILL_RATIO = 0.95;
const URANDOM = "/dev/urandom";

/** Noise over /dev/urandom when it is readable (Linux CI and local compose), else a testsrc2+noise lavfi graph. */
export function noiseInput(readable = () => accessSync(URANDOM)) {
  try { readable(); return URANDOM; } catch { return null; }
}

export function ffmpegArgs(path, sizeBytes, { source = noiseInput() } = {}) {
  // Forty megabits per second keeps even the 2 GiB target a few minutes long; true noise saturates the rate cap
  // so the encoded stream fills the requested size instead of trailing zero padding, and -fs stays the hard cap.
  const seconds = Math.max(1, Math.ceil((sizeBytes * 8) / BITRATE));
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];
  if (source) {
    args.push("-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", "1280x720", "-r", "30", "-t", String(seconds), "-i", source);
  } else {
    args.push("-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${seconds},noise=alls=100:allf=t+u`);
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-b:v", "40M", "-minrate", "40M", "-maxrate", "40M", "-bufsize", "80M",
    "-an", "-fs", String(sizeBytes), path);
  return args;
}

export async function generateSyntheticVideo(path, sizeBytes, {
  ffmpeg = "ffmpeg", exec = execFileSync, stat = statSync, source,
} = {}) {
  const started = performance.now();
  exec(ffmpeg, ffmpegArgs(path, sizeBytes, { source }), { stdio: ["ignore", "ignore", "pipe"] });
  const encodedBytes = stat(path).size;
  if (!encodedBytes) throw new Error("FFmpeg produced an empty file");
  const { sha256, deflateRatio } = await fingerprintFile(path);
  return { sha256, generationMs: performance.now() - started, encodedBytes, deflateRatio };
}

/** One streaming pass over the generated file: SHA-256 plus a level-1 deflate length as the compressibility signal. */
export function fingerprintFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const gzip = createGzip({ level: 1 });
    let compressed = 0;
    let total = 0;
    gzip.on("data", (chunk) => { compressed += chunk.length; });
    gzip.on("error", reject);
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => { total += chunk.length; hash.update(chunk); gzip.write(chunk); });
    input.on("end", () => gzip.end(() => resolve({
      sha256: hash.digest("hex"), bytes: total, deflateRatio: Number((compressed / total).toFixed(4)),
    })));
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

export async function runOne(sizeMb, { env, workDir, headers, s3, deps = {} }) {
  const { generate = generateSyntheticVideo, uploadFile = resumableUpload, hashRemote } = deps;
  const targetBytes = sizeMb * MiB;
  const chunkSize = Number(env.BENCH_CHUNK_MB ?? 8) * MiB;
  const wanted = Number(env.BENCH_INTERRUPTIONS ?? 1);
  const doc = newResult("upload-bench", {
    device: { platform: "server" },
    network: { profile: env.BENCH_NETWORK_PROFILE },
    upload_path: "tusd",
    file: { size_bytes: targetBytes, codec: "h264", vfr: false, hdr: false, bitrate_kbps: BITRATE / 1000 },
  });
  const path = join(workDir, `synthetic-${sizeMb}mb.mp4`);
  const generated = await generate(path, targetBytes, { ffmpeg: env.BENCH_FFMPEG ?? "ffmpeg" });
  // The exact bytes on disk are the upload: the recorded size is real, never padded to the target.
  const sizeBytes = generated.encodedBytes;
  doc.file.size_bytes = sizeBytes;
  const uploadStarted = performance.now();
  const stopSampling = rssSampler(Number(env.BENCH_RSS_SAMPLE_MS ?? 50));
  let upload;
  let uploadRssPeak;
  try {
    upload = await uploadFile({
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
  } else if (hashRemote) {
    remote = await hashRemote(upload.location, headers);
    hashSource = "injected";
  } else {
    remote = await streamHttpSha256(upload.location, headers);
    hashSource = "http-stream";
  }
  const hashMs = performance.now() - hashStarted;
  const assessed = assessUpload(upload, {
    wanted, sizeBytes, chunkSize, localSha256: generated.sha256, remoteSha256: remote.sha256,
  });
  const problems = [...assessed.problems];
  const fillRatio = sizeBytes / targetBytes;
  if (fillRatio < MIN_FILL_RATIO) {
    problems.push(`encoded content filled only ${(fillRatio * 100).toFixed(1)}% of the requested ${targetBytes} bytes`);
  }
  const verified = Boolean(remote.sha256);
  const metrics = {
    generation_time_s: Number((generated.generationMs / 1000).toFixed(3)),
    target_size_bytes: targetBytes,
    encoded_bytes: sizeBytes,
    content_fill_ratio: Number(fillRatio.toFixed(4)),
    content_deflate_ratio: generated.deflateRatio,
    upload_time_s: Number((uploadMs / 1000).toFixed(3)),
    hash_time_s: Number((hashMs / 1000).toFixed(3)),
    total_time_s: Number(((generated.generationMs + uploadMs + hashMs) / 1000).toFixed(3)),
    effective_throughput_mib_s: Number(((sizeBytes / MiB) / (uploadMs / 1000)).toFixed(3)),
    upload_rss_peak_bytes: uploadRssPeak,
    process_max_rss_bytes: process.resourceUsage().maxRSS * 1024,
    chunk_size_bytes: chunkSize,
    interruptions: upload.interruptions,
    resume_count: upload.resumeOffsets.length,
    resume_succeeded: assessed.resumeSucceeded,
    restarts_from_zero: upload.restartsFromZero,
    bytes_sent: upload.bytesSent,
    bytes_resent: assessed.resent,
    patch_calls: upload.patchCalls,
    sha256_match: verified ? remote.sha256 === generated.sha256 : "unverified",
    hash_source: hashSource,
    protocol_violations: upload.violations.length,
  };
  finish(doc, problems.length ? "fail" : verified ? "pass" : "partial", metrics,
    ["ملف ضجيج اصطناعي عالي الإنتروبيا يُولَّد وقت التشغيل ويُحذف بعد القياس؛ الحجم المرفوع هو الحجم المشفَّر الفعلي لا هدفًا محشوًا",
      "نسبة الانضغاط deflate في المقاييس: قربها من 1 يعني محتوى غير قابل للضغط فلا رقم منفَّلت من أي ضغط في الطريق",
      "الإنتاجية فعّالة: تشمل زمن الانقطاع والاستئناف المخططين؛ الذاكرة المعروضة لعملية العميل لا لخادم tusd",
      verified ? null : `تعذر التحقق من البصمة عبر ${hashSource} (HTTP ${remote.status})`,
      problems.length ? problems.join("؛ ") : null].filter(Boolean).join("؛ "));
  return { doc, code: problems.length ? 1 : 0 };
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  const sizes = (env.BENCH_SIZES_MB ?? "100,500,2048").split(",").map(Number);
  if (!sizes.length || sizes.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error("BENCH_SIZES_MB must be comma-separated positive integers");
  console.log(`قياس الرفع والاستئناف: ${sizes.join(", ")} ميغابايت؛ توليد FFmpeg اصطناعي عالي الإنتروبيا وحذف الملفات بعد التشغيل.`);
  if (args["dry-run"]) return { code: 0, doc: null };
  if (!env.BENCH_TUS_ENDPOINT) {
    console.error("ENVIRONMENT: BENCH_TUS_ENDPOINT is required; nothing was measured");
    return { code: 2, doc: null };
  }
  if (!env.BENCH_NETWORK_PROFILE) {
    console.error("ENVIRONMENT: BENCH_NETWORK_PROFILE is required; no number is published without its network profile");
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
        const outcome = await runOne(sizeMb, { env, workDir, headers, s3, deps });
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
