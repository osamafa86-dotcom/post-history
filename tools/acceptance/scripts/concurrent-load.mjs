// concurrent-load: 60 concurrent uploads of 2 GB; no degradation in notification time, none in the upload server's temp disk.
//   LOAD_API_URL  LOAD_TOKENS  + HOOK_BASE_URL HOOK_TOKEN HOOK_OBJECT_PREFIX HOOK_BUCKET  S3_*   (sessions from POST /uploads)
//   LOAD_CONCURRENCY=60  LOAD_SIZE_MB=1 (CI: the hook/S3/verification path, tusd played by this script)
//   LOAD_MODE=tus LOAD_TUS_ENDPOINT=http://…/files/  LOAD_SIZE_MB=2048  the real path: every upload goes through tusd (plan size; manual, see README)
// "No degradation" has no number in the plan. Working criterion until the field trial (coordinator decision), stated in every result: the p95 time from upload finish to the
// reporter's receipt notification under load stays within LOAD_MAX_RATIO (default 5x) of the same p95 measured one upload
// at a time, or within LOAD_MAX_EXTRA_S (default 10 s) of it, whichever is larger.
import { createHash, randomUUID } from "node:crypto";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, materialBody, percentile } from "../lib/live.mjs";
import { hookClient, simulateUpload, waitFor } from "../lib/hooks.mjs";
import { s3FromEnv } from "../lib/s3.mjs";
import { makeSyntheticFile, resumableUpload } from "../lib/tus.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("concurrent-load"));
  const doc = newResult("concurrent-load", { device: { platform: "server" }, upload_path: "n/a" });
  const s3 = s3FromEnv(env);
  if (!env.LOAD_API_URL || !env.HOOK_BASE_URL || !s3) {
    console.error("ENVIRONMENT: LOAD_API_URL, HOOK_BASE_URL and S3_* are required; nothing measured");
    return { code: 2, doc: null };
  }
  const tokens = JSON.parse(env.LOAD_TOKENS ?? "{}");
  const N = Number(env.LOAD_CONCURRENCY ?? 60), sizeMb = Number(env.LOAD_SIZE_MB ?? 1);
  const size = Math.round(sizeMb * 1024 * 1024);
  const maxRatio = Number(env.LOAD_MAX_RATIO ?? 5), maxExtra = Number(env.LOAD_MAX_EXTRA_S ?? 10);
  const http = client(env.LOAD_API_URL), hooks = hookClient({ baseUrl: env.HOOK_BASE_URL, token: env.HOOK_TOKEN });
  const bucket = env.HOOK_BUCKET ?? "uploads", prefix = env.HOOK_OBJECT_PREFIX ?? "tus/";
  let synth = null;
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } };

  try {
    await s3.ensureBucket(bucket);
    const fv = (await http.get(tokens.reporter, "/forms/current")).body.version;
    // one deterministic body reused for every upload keeps memory flat; each object is still a separate S3 write
    const tusMode = env.LOAD_MODE === "tus";
    const body = tusMode ? null : Buffer.alloc(size, 9);
    let expected = body ? createHash("sha256").update(body).digest("hex") : null;

    const one = async (tag) => {
      const mat = (await http.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `load-${tag}-${randomUUID().slice(0, 8)}`) })).body;
      const session = await createUploadSession(http, tokens.reporter, { materialId: mat.id, size, clientSha256: expected });
      return { mat, session };
    };
    const tus = env.LOAD_MODE === "tus";
    if (tus) { synth = await makeSyntheticFile(size); expected = synth.sha256; }
    const finishOne = async ({ mat, session }) => {
      let up;
      if (tus) {
        const t = await resumableUpload({ endpoint: env.LOAD_TUS_ENDPOINT, file: synth.path, size, chunkSize: Number(env.LOAD_CHUNK_MB ?? 8) * 1024 * 1024, interruptAt: [], metadata: { upload_session_id: session.id }, headers: { Authorization: `Bearer ${session.token}` } });
        up = { finishedAt: Date.now() - 0 };
        if (t.violations.length) throw new Error(`tus protocol violations: ${t.violations.join("; ")}`);
      } else up = await simulateUpload({ hooks, s3, bucket, prefix, session, bytes: body });
      const got = await waitFor(async () => (await http.get(tokens.reporter, "/notifications?limit=100")).body.items?.find((n) => n.material_id === mat.id && n.type === "upload.verified"), { timeoutMs: 180_000, everyMs: 200 });
      const file = got.value ? (await http.get(tokens.reporter, `/materials/${mat.id}`)).body.files?.find((f) => f.kind === "original") : null;
      return { ok: Boolean(got.value), seconds: (Date.now() - up.finishedAt) / 1000, shaOk: file?.sha256 === expected, notified: got.value ? 1 : 0 };
    };

    // baseline: one at a time
    const baseN = Number(env.LOAD_BASELINE_RUNS ?? 8), base = [];
    for (let i = 0; i < baseN; i++) base.push(await finishOne(await one(`b${i}`)));
    // load: all prepared first, then released together
    const prepared = [];
    for (let i = 0; i < N; i++) prepared.push(await one(`c${i}`));
    const t0 = Date.now();
    const loaded = await Promise.all(prepared.map(finishOne));
    const wall = (Date.now() - t0) / 1000;

    const sec = (xs) => xs.filter((x) => x.ok).map((x) => x.seconds).sort((a, b) => a - b);
    const pBase = percentile(sec(base), 95), pLoad = percentile(sec(loaded), 95);
    const limit = Math.max(pBase * maxRatio, pBase + maxExtra);
    check("every baseline upload verified and notified", base.every((x) => x.ok && x.shaOk));
    check(`all ${N} concurrent uploads verified and notified`, loaded.every((x) => x.ok), `${loaded.filter((x) => x.ok).length}/${N}`);
    check("server SHA-256 correct for every concurrent upload", loaded.every((x) => x.shaOk));
    check(`notification p95 under load within ${maxRatio}x or +${maxExtra}s of the baseline`, pLoad <= limit, `${pLoad}s > ${limit.toFixed(1)}s (baseline ${pBase}s)`);
    console.log(`baseline p95=${pBase}s  load(${N}x${sizeMb}MiB) p95=${pLoad}s wall=${wall.toFixed(1)}s limit=${limit.toFixed(1)}s`);

    finish(doc, fails.length ? "fail" : "partial", {
      concurrency: N, file_size_mb: sizeMb, verified_ok: loaded.filter((x) => x.ok).length, sha256_ok: loaded.filter((x) => x.shaOk).length,
      notification_s_p50_baseline: percentile(sec(base), 50), notification_s_p95_baseline: pBase,
      notification_s_p50_load: percentile(sec(loaded), 50), notification_s_p95_load: pLoad, notification_s_max_load: sec(loaded).at(-1),
      wall_s: Number(wall.toFixed(1)), degradation_ratio_p95: Number((pLoad / pBase).toFixed(2)), degradation_threshold: `${maxRatio}x or +${maxExtra}s`,
      hook_latency_ms_p95: hooks.latencies.length ? percentile([...hooks.latencies].sort((a, b) => a - b), 95) : "n/a", upload_path_real_tusd: tus, upload_server_temp_disk_measured: false, failures: fails.length,
    }, `${tus ? "عبر tusd حقيقي" : "مسار الخطّاف وS3 والتحقق على الخادم (tusd مُحاكى)"} بملفات ${sizeMb} ميغابايت؛ لا قياس لقرص خادم الرفع المؤقت، وحد «لا تدهور» معيار عامل بقرار المنسّق حتى التجربة الميدانية؛ حجم الخطة (60 × 2 غيغابايت عبر tusd) سكربت يدوي`);
    if (args["dry-run"]) writeResult(doc, { dryRun: true });
    else console.log("wrote", writeResult(doc, { slug: `${N}x${sizeMb}mb` }));
    return { code: fails.length ? 1 : 0, doc };
  } finally { synth?.cleanup(); }
}
