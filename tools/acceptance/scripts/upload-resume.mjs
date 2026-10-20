// upload-resume: interrupted upload resumes with only the missing parts and the full SHA-256 matches on the server.
// Plan row "استئناف الرفع" (5 GiB, three interruptions, network switch). CI runs a small file against the local tusd;
// the full-size run is `UPLOAD_SIZE_MB=5120` against the compose stack and is what the gate result must come from.
//   UPLOAD_ENDPOINT=http://127.0.0.1:8080/files/  UPLOAD_SIZE_MB=64  UPLOAD_CHUNK_MB=4  UPLOAD_INTERRUPTIONS=3
// Hash verification: when tusd runs with -disable-download (the compose stack) it cannot be read back over HTTP, so with
//   UPLOAD_S3_ENDPOINT UPLOAD_S3_ACCESS_KEY UPLOAD_S3_SECRET_KEY UPLOAD_S3_BUCKET [UPLOAD_S3_PREFIX]
// the stored object is streamed from S3/MinIO instead; without them it falls back to GET on the upload URL.
// Against a remote host (the field-trial pack): UPLOAD_API_URL + UPLOAD_TOKEN (a reporter's access token). The upload is then a real
// session (material, POST /uploads, the upload token on tus create) of a valid synthetic clip of about UPLOAD_SIZE_MB, because the media
// worker rejects random bytes, and the hash is confirmed by the server itself: the session reaches `verified` (its SHA-256 = the client's).
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { makeSyntheticFile, resumableUpload, serverSha256 } from "../lib/tus.mjs";
import { s3FromEnv, tusObjectKey } from "../lib/s3.mjs";
import { client, createUploadSession, materialBody, sleep } from "../lib/live.mjs";
import { synthClip, sha256File } from "../lib/media-clips.mjs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MiB = 1 << 20;

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("upload-resume"));
  const endpoint = env.UPLOAD_ENDPOINT ?? "http://127.0.0.1:8080/files/";
  const sizeMb = Number(env.UPLOAD_SIZE_MB ?? 64);
  const chunkSize = Number(env.UPLOAD_CHUNK_MB ?? 4) * MiB;
  const wanted = Number(env.UPLOAD_INTERRUPTIONS ?? 3);
  const viaApi = Boolean(env.UPLOAD_API_URL && env.UPLOAD_TOKEN);
  let size = Math.round(sizeMb * MiB);
  const doc = newResult("upload-resume", {
    device: { platform: "server" },
    network: { profile: env.UPLOAD_NETWORK_PROFILE ?? "loopback" },
    upload_path: "tusd",
    file: { size_bytes: size },
  });

  let synth, session = null, api = null;
  if (viaApi) {
    const dir = mkdtempSync(join(tmpdir(), "resume-"));
    // random pixels at a fixed 8 Mbit/s: about one MB per second, a valid clip of a predictable size
    const path = synthClip(join(dir, "resume.mp4"), { seconds: Math.max(4, sizeMb), size: "640x360", rate: 25, noise: true, tags: false });
    size = statSync(path).size;
    synth = { path, sha256: await sha256File(path), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
    doc.file.size_bytes = size;
    api = client(env.UPLOAD_API_URL);
    const fv = (await api.get(env.UPLOAD_TOKEN, "/forms/current")).body?.version;
    const mat = (await api.call(env.UPLOAD_TOKEN, "POST", "/materials", { body: materialBody(fv, `resume-${Date.now()}`) })).body;
    session = await createUploadSession(api, env.UPLOAD_TOKEN, { materialId: mat.id, size, clientSha256: synth.sha256 });
  } else synth = await makeSyntheticFile(size);
  try {
    // interruption points spread over the file, each inside a chunk (never on a boundary)
    const interruptAt = Array.from({ length: wanted }, (_, i) => Math.floor((size * (i + 1)) / (wanted + 1)) + Math.floor(chunkSize / 3));
    console.log(`endpoint=${endpoint} size=${sizeMb}MiB chunk=${chunkSize / MiB}MiB interruptions at`, interruptAt.map((b) => `${(b / MiB).toFixed(1)}MiB`).join(", "));
    let up;
    try {
      up = await resumableUpload({ endpoint, file: synth.path, size, chunkSize, interruptAt,
        ...(session ? { metadata: { upload_session_id: session.id }, headers: { Authorization: `Bearer ${session.token}` } } : {}) });
    } catch (e) {
      console.error(`ENVIRONMENT: could not drive tusd at ${endpoint}: ${e.message}`);
      return { code: 2, doc: null }; // no server = nothing measured, no result file
    }
    const s3 = s3FromEnv(env, "UPLOAD_S3");
    let remote, hashSource;
    if (session) {
      // the server verifies the SHA-256 against the client's declared one; `verified` with a receipt is its confirmation
      let last = null;
      for (let i = 0; i < 480 && !["verified", "failed", "deduplicated"].includes(last?.state); i++) { await sleep(500); last = (await api.get(env.UPLOAD_TOKEN, `/uploads/${session.id}`)).body; }
      remote = { sha256: last?.state === "verified" ? synth.sha256 : null, status: `session ${last?.state ?? "unknown"}${last?.failure_reason ? ` (${last.failure_reason})` : ""}` };
      hashSource = "api-verified";
    } else if (s3) {
      const key = tusObjectKey(env.UPLOAD_S3_PREFIX ?? "", up.location);
      remote = { sha256: await s3.sha256(env.UPLOAD_S3_BUCKET ?? "uploads", key), status: "s3" };
      hashSource = "s3";
    } else {
      remote = await serverSha256(up.location);
      hashSource = "http-get";
    }
    const resent = up.bytesSent - size;
    const problems = [...up.violations];
    if (up.interruptions < wanted) problems.push(`only ${up.interruptions}/${wanted} interruptions happened`);
    if (up.restartsFromZero) problems.push(`${up.restartsFromZero} resume(s) restarted from offset 0`);
    if (resent > up.interruptions * chunkSize) problems.push(`re-sent ${resent} bytes, more than ${up.interruptions} chunk(s)`);
    if (remote.sha256 && remote.sha256 !== synth.sha256) problems.push("server SHA-256 differs from the local file");
    problems.forEach((p) => console.log(`FAIL ${p}`));
    const verified = Boolean(remote.sha256);
    if (!verified) console.log(`SHA-256 not verified (${hashSource}): ${remote.status}`);

    // the row is a 5 GiB criterion: a smaller file proves the mechanism, not the gate
    const fullSize = sizeMb >= 5120;
    finish(doc, problems.length ? "fail" : verified && fullSize ? "pass" : "partial", {
      interruptions: up.interruptions,
      network_switches_simulated: up.networkSwitches,
      resume_count: up.resumeOffsets.length,
      restarts_from_zero: up.restartsFromZero,
      bytes_sent: up.bytesSent,
      bytes_resent: Math.max(resent, 0),
      resent_pct: Number(((Math.max(resent, 0) / size) * 100).toFixed(3)),
      chunk_size_bytes: chunkSize,
      patch_calls: up.patchCalls,
      total_time_s: Number((up.durationMs / 1000).toFixed(2)),
      sha256_match: verified ? remote.sha256 === synth.sha256 : "unverified",
      protocol_violations: up.violations.length,
      hash_source: hashSource,
    }, [`تبديل الشبكة هنا إعادة بناء مجمّع الاتصالات على الجهاز نفسه؛ تغيّر العنوان الحقيقي يقيسه netlab والاختبار الميداني`,
        sizeMb < 5120 ? `الحجم ${sizeMb} ميغابايت للتحقق الآلي؛ معيار البوابة ملف 5 غيغابايت (UPLOAD_SIZE_MB=5120)` : null,
        verified ? null : "لم تُتحقق البصمة: الخادم لا يقدّم GET ولا إعدادات S3",
        env.UPLOAD_ENV_NOTE ?? null].filter(Boolean).join("؛ "));
    if (args["dry-run"]) writeResult(doc, { dryRun: true });
    else console.log("wrote", writeResult(doc, { slug: `${sizeMb}mb` }));
    return { code: problems.length ? 1 : 0, doc };
  } finally {
    synth.cleanup();
  }
}
