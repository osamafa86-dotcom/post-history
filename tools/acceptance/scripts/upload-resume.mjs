// upload-resume: interrupted upload resumes with only the missing parts and the full SHA-256 matches on the server.
// Plan row "استئناف الرفع" (5 GiB, three interruptions, network switch). CI runs a small file against the local tusd;
// the full-size run is `UPLOAD_SIZE_MB=5120` against the compose stack and is what the gate result must come from.
//   UPLOAD_ENDPOINT=http://127.0.0.1:8080/files/  UPLOAD_SIZE_MB=64  UPLOAD_CHUNK_MB=4  UPLOAD_INTERRUPTIONS=3
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { makeSyntheticFile, resumableUpload, serverSha256 } from "../lib/tus.mjs";

const MiB = 1 << 20;

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("upload-resume"));
  const endpoint = env.UPLOAD_ENDPOINT ?? "http://127.0.0.1:8080/files/";
  const sizeMb = Number(env.UPLOAD_SIZE_MB ?? 64);
  const chunkSize = Number(env.UPLOAD_CHUNK_MB ?? 4) * MiB;
  const wanted = Number(env.UPLOAD_INTERRUPTIONS ?? 3);
  const size = Math.round(sizeMb * MiB);
  const doc = newResult("upload-resume", {
    device: { platform: "server" },
    network: { profile: env.UPLOAD_NETWORK_PROFILE ?? "loopback" },
    upload_path: "tusd",
    file: { size_bytes: size },
  });

  const synth = await makeSyntheticFile(size);
  try {
    // interruption points spread over the file, each inside a chunk (never on a boundary)
    const interruptAt = Array.from({ length: wanted }, (_, i) => Math.floor((size * (i + 1)) / (wanted + 1)) + Math.floor(chunkSize / 3));
    console.log(`endpoint=${endpoint} size=${sizeMb}MiB chunk=${chunkSize / MiB}MiB interruptions at`, interruptAt.map((b) => `${(b / MiB).toFixed(1)}MiB`).join(", "));
    let up;
    try {
      up = await resumableUpload({ endpoint, file: synth.path, size, chunkSize, interruptAt });
    } catch (e) {
      console.error(`ENVIRONMENT: could not drive tusd at ${endpoint}: ${e.message}`);
      return { code: 2, doc: null }; // no server = nothing measured, no result file
    }
    const remote = await serverSha256(up.location);
    const resent = up.bytesSent - size;
    const problems = [...up.violations];
    if (up.interruptions < wanted) problems.push(`only ${up.interruptions}/${wanted} interruptions happened`);
    if (up.restartsFromZero) problems.push(`${up.restartsFromZero} resume(s) restarted from offset 0`);
    if (resent > up.interruptions * chunkSize) problems.push(`re-sent ${resent} bytes, more than ${up.interruptions} chunk(s)`);
    if (remote.sha256 && remote.sha256 !== synth.sha256) problems.push("server SHA-256 differs from the local file");
    problems.forEach((p) => console.log(`FAIL ${p}`));
    const verified = Boolean(remote.sha256);
    if (!verified) console.log(`SHA-256 not verified: GET answered HTTP ${remote.status}`);

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
    }, [`تبديل الشبكة هنا إعادة بناء مجمّع الاتصالات على الجهاز نفسه؛ تغيّر العنوان الحقيقي يقيسه netlab والاختبار الميداني`,
        sizeMb < 5120 ? `الحجم ${sizeMb} ميغابايت للتحقق الآلي؛ معيار البوابة ملف 5 غيغابايت (UPLOAD_SIZE_MB=5120)` : null,
        verified ? null : "الخادم لا يقدّم GET فلم تُتحقق البصمة",
        env.UPLOAD_ENV_NOTE ?? null].filter(Boolean).join("؛ "));
    if (args["dry-run"]) writeResult(doc, { dryRun: true });
    else console.log("wrote", writeResult(doc, { slug: `${sizeMb}mb` }));
    return { code: problems.length ? 1 : 0, doc };
  } finally {
    synth.cleanup();
  }
}
