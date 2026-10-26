// media-e2e: the media pipeline end to end on the full compose stack (API + tusd + MinIO + Redis + media worker).
// Feeds two rows of the acceptance table, both recorded as `partial` with what is not measured stated:
//   proxy-accuracy  a synthetic phone-style clip (VFR, a gap, a shifted start, revealing container tags) is uploaded;
//                   the event is consumed, the session verifies (server SHA-256 = the client's), the proxy appears in the
//                   media bucket under derived/<material_id>/, the original is untouched, nothing revealing leaks, the
//                   proxy keeps start_pts and lands within 40 ms of the original at 10 random cut points; a 2-minute 1080p
//                   clip gives the time from upload complete to proxy available. The two thumbnails (poster.jpg and
//                   contact-sheet.jpg under derived/<material_id>/<file_id>/) must exist, be real JPEGs and carry none of the planted
//                   tags; whether the server registered the poster is recorded (thumbnail_registered), not required.
//   invalid-file    (media worker part) playlists/concat lists dressed as video and a truncated clip end `failed`, with no
//                   derivative and no call out of the container.
// Environment (compose published ports; see .github/workflows/acceptance.yml):
//   MEDIA_E2E_API_URL  (http://127.0.0.1:3000/v1)   DATABASE_URL (read access, and the seed)
//   MEDIA_E2E_TUS_URL  (http://127.0.0.1:8080/files/)           or HOOK_BASE_URL + HOOK_TOKEN to simulate tusd (local runs)
//   S3_ENDPOINT S3_ACCESS_KEY S3_SECRET_KEY  (MinIO)   MEDIA_E2E_BUCKET_UPLOADS (uploads)  MEDIA_E2E_BUCKET_MEDIA (media)
//   MEDIA_E2E_LOGS_CMD  a shell command printing the worker's log (docker compose ... logs media-worker)
//   MEDIA_E2E_LONG_S (120)  MEDIA_E2E_TIMEOUT_S (240)  MEDIA_E2E_CALLOUT_HOST (host the container could reach, default 172.17.0.1)
// Flags: --dry-run (no result files)  --out-dir=<dir> (write the result files there instead of docs/measurements/acceptance)
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, eventsOfType, materialBody, sleep } from "../lib/live.mjs";
import { hookClient, simulateUpload, waitFor } from "../lib/hooks.mjs";
import { s3FromEnv } from "../lib/s3.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { tusAuth } from "../lib/ingest.mjs";
import { scan } from "../lib/pii.mjs";
import { seed } from "../live/seed.mjs";
import { LEAK_VALUES, cutBack, durationSeconds, formatStart, hostilePayloads, imageSize, phoneProxy, sha256File, synthClip, tagDump, videoTimes } from "../lib/media-clips.mjs";

const TOLERANCE_MS = 40;

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("proxy-accuracy"));
  const s3 = s3FromEnv(env);
  const tusUrl = env.MEDIA_E2E_TUS_URL, viaHooks = env.HOOK_BASE_URL && env.HOOK_TOKEN;
  if (!env.MEDIA_E2E_API_URL || !env.DATABASE_URL || !s3 || !(tusUrl || viaHooks)) {
    console.error("ENVIRONMENT: MEDIA_E2E_API_URL, DATABASE_URL, S3_* and MEDIA_E2E_TUS_URL (or HOOK_*) are required; nothing measured");
    return { code: 2, doc: null };
  }
  const bucketUp = env.MEDIA_E2E_BUCKET_UPLOADS ?? "uploads", bucketMedia = env.MEDIA_E2E_BUCKET_MEDIA ?? "media";
  const prefix = env.HOOK_OBJECT_PREFIX ?? "tus/";
  const longS = Number(env.MEDIA_E2E_LONG_S ?? 120), timeoutMs = Number(env.MEDIA_E2E_TIMEOUT_S ?? 240) * 1000;
  const calloutHost = env.MEDIA_E2E_CALLOUT_HOST ?? "172.17.0.1";
  const work = mkdtempSync(join(tmpdir(), "media-e2e-"));
  const started = new Date().toISOString();
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); };
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
  const q = async (text, params) => (await pool.query(text, params)).rows;
  let callout;
  try {
    const s = await seed({ databaseUrl: env.DATABASE_URL, apiUrl: env.MEDIA_E2E_API_URL });
    const api = client(env.MEDIA_E2E_API_URL);
    const reporter = s.tokens.reporter, admin = s.tokens.system_admin;
    const fv = (await api.get(reporter, "/forms/current")).body.version;
    await s3.ensureBucket(bucketUp);
    await s3.ensureBucket(bucketMedia);
    const hooks = viaHooks ? hookClient({ baseUrl: env.HOOK_BASE_URL, token: env.HOOK_TOKEN }) : null;

    /** Upload a local file as a reporter would: session, then tus (or the simulated hooks locally). Returns what the checks need. */
    const submit = async (path, label, opts = {}) => {
      const mat = opts.mat ?? (await api.call(reporter, "POST", "/materials", { body: materialBody(fv, `media-e2e-${label}-${Date.now()}`) })).body;
      const sha = await sha256File(path), size = statSync(path).size;
      const session = await createUploadSession(api, reporter, { materialId: mat.id, size, clientSha256: sha, filename: label, kind: opts.kind ?? "original" });
      const t0 = Date.now();
      if (tusUrl) {
        const up = await resumableUpload({ endpoint: tusUrl, file: path, size, chunkSize: 8 * 1024 * 1024, interruptAt: [], metadata: { upload_session_id: session.id }, headers: () => tusAuth(session) });
        if (up.violations.length) throw new Error(`tus violations: ${up.violations.join("; ")}`);
      } else {
        await simulateUpload({ hooks, s3, bucket: bucketUp, prefix, session, bytes: readFileSync(path) });
      }
      const finishedAt = Date.now();
      return { mat, session, sha, size, uploadS: (finishedAt - t0) / 1000, finishedAt };
    };
    // the session's final state, with the seconds from upload complete to the poll that saw it
    const settle = async (sub) => {
      const v = (await waitFor(async () => {
        const r = (await api.get(reporter, `/uploads/${sub.session.id}`)).body;
        return ["verified", "failed", "deduplicated"].includes(r.state) ? { ...r, seenAfterS: (Date.now() - sub.finishedAt) / 1000 } : null;
      }, { timeoutMs, everyMs: 250 })).value;
      return v;
    };

    // ---- A. a phone-style clip and a 2-minute 1080p clip
    const vfr = synthClip(join(work, "phone.mov"), { seconds: 20, vfr: true, gap: [8, 9], startOffset: 5 });
    const subV = await submit(vfr, "phone.mov");
    const statV = await s3.stat(bucketUp, `${prefix}${subV.session.id}`);
    const doneV = await settle(subV);
    check("phone clip: the session verifies", doneV?.state === "verified", `state ${doneV?.state ?? "timeout"}`);
    check("phone clip: the receipt number is issued", /^R-\d{6}-\d{6}$/.test(doneV?.receipt_number ?? ""), String(doneV?.receipt_number));
    const [fileV] = await q(`SELECT mf.id, mf.sha256, mf.start_pts_us, mf.technical FROM material_files mf WHERE mf.material_id = $1 AND mf.kind = 'original'`, [subV.mat.id]);
    check("phone clip: the server's SHA-256 equals the client's", fileV?.sha256?.toString("hex") === subV.sha);
    const proxyRow = async (fileId) => (await waitFor(async () => (await q(`SELECT id, storage_key, state, sha256, start_pts_us, technical FROM material_files WHERE derived_from_id = $1 AND kind = 'proxy'`, [fileId]))[0] ?? null, { timeoutMs, everyMs: 250 })).value;
    const proxyV = fileV ? await proxyRow(fileV.id) : null;
    check("phone clip: a proxy row exists and is verified", proxyV?.state === "verified");
    const derivedKeys = (await s3.list(bucketMedia, `derived/${subV.mat.id}/`)).map((o) => o.key);
    check("phone clip: the proxy object is in the media bucket under derived/<material_id>/", Boolean(proxyV) && derivedKeys.includes(proxyV.storage_key), derivedKeys.join(","));
    check("phone clip: nothing derived went to the uploads bucket", (await s3.list(bucketUp, `derived/`)).length === 0);

    let cut = { maxMs: Infinity, points: [], originalFrames: 0, proxyFrames: 0 }, proxyTags = "";
    if (proxyV) {
      const local = join(work, "phone-proxy.mp4");
      await s3.download(bucketMedia, proxyV.storage_key, local);
      cut = cutBack(videoTimes(vfr), videoTimes(local));
      proxyTags = tagDump(local);
      check("phone clip: the proxy's SHA-256 recorded by the server is that of the stored object", (await sha256File(local)) === proxyV.sha256?.toString("hex"));
    }
    check(`phone clip: ten random cut points land within ${TOLERANCE_MS} ms of the original`, cut.maxMs <= TOLERANCE_MS, `worst ${cut.maxMs} ms`);
    check("phone clip: every frame timestamp is carried over (same frame count)", cut.originalFrames > 0 && cut.originalFrames === cut.proxyFrames, `${cut.originalFrames} vs ${cut.proxyFrames}`);
    const startGapUs = fileV && proxyV ? Math.abs(Number(fileV.start_pts_us) - Number(proxyV.start_pts_us)) : Infinity;
    check("phone clip: the proxy keeps the original start_pts", startGapUs <= 16_000, `${startGapUs} us`);

    // thumbnails (#84): the poster and the contact sheet next to the original's id, real images, nothing revealing in them
    const thumbKeys = ["poster.jpg", "contact-sheet.jpg"].map((n) => `derived/${subV.mat.id}/${fileV?.id}/${n}`);
    const thumbs = [];
    for (const key of thumbKeys) {
      const local = join(work, key.split("/").pop());
      const got = await waitFor(async () => { try { await s3.download(bucketMedia, key, local); return true; } catch { return null; } }, { timeoutMs: 60_000, everyMs: 1000 });
      thumbs.push(got.value ? local : null);
    }
    check("phone clip: poster.jpg and contact-sheet.jpg exist under derived/<material_id>/<file_id>/", thumbs.every(Boolean), thumbKeys.map((k, i) => `${k.split("/").pop()}=${Boolean(thumbs[i])}`).join(" "));
    const bytes = thumbs.map((t) => (t ? readFileSync(t) : null));
    check("phone clip: both thumbnails are JPEG images with readable dimensions", thumbs.every((t, i) => t && bytes[i][0] === 0xff && bytes[i][1] === 0xd8 && bytes[i].length > 1024 && imageSize(t)), thumbs.map((t, i) => (t ? `${bytes[i].length}B ${JSON.stringify(imageSize(t))}` : "missing")).join(" "));
    const thumbRow = (await q(`SELECT id FROM material_files WHERE derived_from_id = $1 AND kind = 'thumbnail'`, [fileV?.id ?? "00000000-0000-0000-0000-000000000000"]))[0];
    // not a check: the server does not accept kind=thumbnail on /internal/media/files/{id}/derivatives yet (the worker logs
    // "thumbnail not registered ... ApiRejected" and ends "+thumbnails-unregistered"); the files exist in storage. Recorded as a finding.
    console.log(`note ${thumbRow ? "the poster is registered as a thumbnail of the original" : "the poster is NOT registered by the server (kind=thumbnail refused); the files are in storage"}`);
    const thumbLeaks = thumbs.reduce((n, t, i) => n + (t ? scan([bytes[i].toString("latin1"), tagDump(t)], { keys: false, canaries: LEAK_VALUES }).length : 0), 0);
    check("phone clip: the planted tags are in neither thumbnail (bytes or tags)", thumbLeaks === 0, `${thumbLeaks} hit(s)`);

    const afterV = await s3.stat(bucketUp, `${prefix}${subV.session.id}`);
    check("phone clip: the original object is unchanged (ETag and last-modified)", Boolean(statV) && statV.etag === afterV?.etag && statV.lastModified === afterV?.lastModified);
    check("phone clip: the stored original still hashes to the client's SHA-256", (await s3.sha256(bucketUp, `${prefix}${subV.session.id}`)) === subV.sha);

    // the long clip: upload complete -> proxy available
    const longPath = synthClip(join(work, "long.mov"), { seconds: longS, size: "1920x1080" });
    const subL = await submit(longPath, "long.mov");
    const fileL = await waitFor(async () => (await q(`SELECT id FROM material_files WHERE material_id = $1 AND kind = 'original'`, [subL.mat.id]))[0] ?? null, { timeoutMs, everyMs: 250 });
    const proxyL = fileL.value ? await proxyRow(fileL.value.id) : null;
    const proxyReadyS = proxyL ? (Date.now() - subL.finishedAt) / 1000 : null;
    check("long clip: the proxy becomes available", Boolean(proxyL));
    const longSeconds = durationSeconds(longPath);

    // ---- no revealing data anywhere the worker or the pipeline writes
    const logs = env.MEDIA_E2E_LOGS_CMD ? execSync(env.MEDIA_E2E_LOGS_CMD, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) : null;
    const dbDump = [fileV?.technical, proxyV?.technical, proxyL?.technical, (await q(`SELECT technical FROM material_files WHERE material_id = ANY($1::uuid[])`, [[subV.mat.id, subL.mat.id]])).map((r) => r.technical)];
    const apiDump = [(await api.get(reporter, `/materials/${subV.mat.id}`)).body, (await api.get(reporter, `/uploads/${subV.session.id}`)).body];
    const leaks = {
      worker_logs: logs === null ? null : scan(logs.split("\n"), { keys: false, canaries: LEAK_VALUES }).length,
      database_technical: scan(dbDump, { keys: false, canaries: LEAK_VALUES }).length,
      api_responses: scan(apiDump, { canaries: LEAK_VALUES }).length,
      proxy_tags: scan([proxyTags], { keys: false, canaries: LEAK_VALUES }).length,
    };
    check("revealing tags planted in the clip surface nowhere (worker log, technical data, API, proxy tags)", Object.values(leaks).every((n) => n === null || n === 0), JSON.stringify(leaks));
    check("the worker's log was read", logs !== null && logs.length > 0, "set MEDIA_E2E_LOGS_CMD");

    // ---- B. hostile files dressed as video
    let calloutHits = 0;
    callout = http.createServer((_req, res) => { calloutHits++; res.end("x"); });
    await new Promise((r) => callout.listen(0, "0.0.0.0", r));
    const calloutUrl = `http://${calloutHost}:${callout.address().port}/canary`;
    const hostile = hostilePayloads({ calloutUrl });
    const truncated = join(work, "truncated.mov");
    const whole = readFileSync(vfr);
    writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
    const cases = [...hostile.map((h) => ({ ...h, path: (writeFileSync(join(work, h.name), h.bytes), join(work, h.name)) })), { label: "truncated-clip", name: "truncated.mov", path: truncated }];
    const rejected = [];
    for (const c of cases) {
      const sub = await submit(c.path, c.name);
      const done = await settle(sub);
      const fileRows = await q(`SELECT kind FROM material_files WHERE material_id = $1`, [sub.mat.id]);
      const ev = (await eventsOfType(api, admin, "upload.failed")).find((e) => e.aggregate_id === sub.session.id);
      const verifiedEv = (await eventsOfType(api, admin, "upload.verified")).find((e) => e.aggregate_id === sub.session.id);
      const [mt] = await q(`SELECT technical_state FROM materials WHERE id = $1`, [sub.mat.id]);
      const derived = await s3.list(bucketMedia, `derived/${sub.mat.id}/`);
      const ok = done?.state === "failed" && done.failure_reason === "invalid_file" && Boolean(ev) && !verifiedEv && !fileRows.some((r) => r.kind === "proxy") && derived.length === 0 && mt?.technical_state === "failed";
      check(`${c.label}: failed as invalid_file, one upload.failed, no derivative, technical state failed`, ok, `${done?.state}/${done?.failure_reason} proxy=${fileRows.some((r) => r.kind === "proxy")} derived=${derived.length} tech=${mt?.technical_state}`);
      rejected.push(c.label);
    }
    await sleep(1000);
    check("no request left the container for the callout listener", calloutHits === 0, `${calloutHits} hit(s)`);
    const logsAfter = env.MEDIA_E2E_LOGS_CMD ? execSync(env.MEDIA_E2E_LOGS_CMD, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) : "";
    check("the worker's log carries no path or playlist content from the hostile files", !/\/etc\/hostname|EXTM3U|ffconcat|canary/.test(logsAfter));


    // ---- C. audio alignment (MEDIA_ENABLE_ALIGNMENT on the worker, #274/#280): the phone's own light copy first, then the original
    //          (the order the phones upload in); the server must end up holding the offset, within the row's 40 ms of the truth.
    let align = null;
    if (env.MEDIA_E2E_ALIGNMENT === "1") {
      const SKIP_S = 2;
      const orig = synthClip(join(work, "align-original.mov"), { seconds: 30, vfr: true, startOffset: 3.5, varied: true, tags: false });
      const prox = phoneProxy(orig, join(work, "align-phone.mp4"), { skipS: SKIP_S, seconds: 24 });
      const truthMs = (formatStart(orig) + SKIP_S) * 1000;
      const mat = (await api.call(reporter, "POST", "/materials", { body: materialBody(fv, `media-e2e-align-${Date.now()}`) })).body;
      const subP = await submit(prox, "align-phone.mp4", { mat, kind: "proxy" });
      const doneP = await settle(subP);
      check("alignment: the phone's light copy verifies", doneP?.state === "verified", `state ${doneP?.state ?? "timeout"}`);
      const subO = await submit(orig, "align-original.mov", { mat });
      const doneO = await settle(subO);
      check("alignment: the original verifies", doneO?.state === "verified", `state ${doneO?.state ?? "timeout"}`);
      const row = (await waitFor(async () => (await q(`SELECT f.id, f.alignment_original_file_id AS orig, f.alignment_offset_ms AS offset_ms, f.alignment_reliable AS reliable, f.alignment_confidence AS confidence
          FROM material_files f WHERE f.material_id = $1 AND f.kind = 'proxy' AND f.derived_from_id IS NULL AND f.alignment_reliable IS NOT NULL`, [mat.id]))[0] ?? null, { timeoutMs, everyMs: 500 })).value;
      const [origRow] = await q(`SELECT id FROM material_files WHERE material_id = $1 AND kind = 'original' AND state = 'verified'`, [mat.id]);
      check("alignment: the server holds an alignment for the phone's light copy", Boolean(row), "none recorded: the pair may have raced, or the flag is off");
      check("alignment: it names this material's verified original", Boolean(row) && row.orig === origRow?.id, `${row?.orig} vs ${origRow?.id}`);
      check("alignment: marked reliable", row?.reliable === true, `reliable ${row?.reliable}, confidence ${row?.confidence}`);
      const errMs = row ? Math.abs(Number(row.offset_ms) - truthMs) : Infinity;
      check(`alignment: the offset is within ${TOLERANCE_MS} ms of the one built in`, errMs <= TOLERANCE_MS, `${row?.offset_ms} vs ${truthMs.toFixed(1)} ms`);
      const shown = (await api.get(reporter, `/materials/${mat.id}`)).body?.files?.find((f) => f.kind === "proxy" && f.alignment);
      check("alignment: Material.files carries it for the light copy, numbers only", Boolean(shown) && Object.keys(shown.alignment).sort().join() === "confidence,margin,offset_ms,original_file_id,reliable", JSON.stringify(shown?.alignment ?? null));
      align = { error_ms: errMs, truth_ms: truthMs, confidence: Number(row?.confidence ?? 0) };
    }

    // ---- results
    const device = { platform: "server", model: env.MEDIA_E2E_ENV_LABEL ?? (tusUrl ? "compose: api + tusd + minio + redis + media-worker" : "local processes: api + simulated tusd hooks + S3 emulator + redis + media worker") };
    const tail = ["لم يُقَس: HDR بألوان صحيحة في النسخة الخفيفة، ولا ملف هاتف حقيقي (المقاطع اصطناعية من FFmpeg)", "المصغّرتان فُحصتا وجودًا وصيغةً وغياب الوسوم، لا جودة الصورة ولا اختيار الإطار؛ تسجيل المصغّرة في الخادم يُسجَّل في المقاييس (thumbnail_registered) وليس شرطًا: الخادم لا يقبل نوع thumbnail بعد"].join("؛ ");
    const doc = newResult("proxy-accuracy", { device, upload_path: tusUrl ? "tusd" : "n/a", file: { size_bytes: subL.size, duration_s: Number(longSeconds.toFixed(3)), codec: "h264", vfr: false, hdr: false } });
    doc.started_at = started;
    const proxyFails = fails.filter((f) => !/^(hls|concat|truncated|no request|the worker's log carries|alignment:)/.test(f));
    finish(doc, proxyFails.length ? "fail" : "partial", {
      cut_points: cut.points.length, cut_matched_by_frame_index: Boolean(cut.byIndex), cut_worst_gap_ms: cut.maxMs, cut_tolerance_ms: TOLERANCE_MS,
      frames_original: cut.originalFrames, frames_proxy: cut.proxyFrames, start_pts_gap_us: startGapUs,
      phone_upload_s: Number(subV.uploadS.toFixed(2)), phone_upload_to_verified_s: Number((doneV?.seenAfterS ?? -1).toFixed(2)),
      long_clip_proxy_ready_s: proxyReadyS === null ? -1 : Number(proxyReadyS.toFixed(2)), long_clip_duration_s: Number(longSeconds.toFixed(1)),
      leak_hits_worker_logs: leaks.worker_logs ?? -1, leak_hits_database: leaks.database_technical, leak_hits_api: leaks.api_responses, leak_hits_proxy_tags: leaks.proxy_tags,
      original_unchanged: Boolean(statV) && statV.etag === afterV?.etag, thumbnails_present: thumbs.filter(Boolean).length, thumbnail_registered: Boolean(thumbRow), thumbnail_leak_hits: thumbLeaks, failures: proxyFails.length,
    }, `${proxyFails.length ? `فشل: ${proxyFails.join("؛ ")}. ` : ""}${tail}. زمن «اكتمال الرفع ← توفر النسخة الخفيفة» للمقطع الطويل رقم معلوماتي: الخطة لا تحدد له معيارًا`);
    const doc2 = newResult("invalid-file", { device, upload_path: tusUrl ? "tusd" : "n/a" });
    doc2.started_at = started;
    const rejectFails = fails.filter((f) => /^(hls|concat|truncated|no request|the worker's log carries)/.test(f));
    finish(doc2, rejectFails.length ? "fail" : "partial", {
      hostile_cases: cases.length, hostile_cases_rejected: cases.length - rejectFails.filter((f) => /failed as invalid_file/.test(f)).length,
      callout_hits: calloutHits, failures: rejectFails.length,
    }, `${rejectFails.length ? `فشل: ${rejectFails.join("؛ ")}. ` : ""}عامل الوسائط: قوائم HLS وconcat بامتداد فيديو وملف مقطوع تنتهي failed بسبب invalid_file بلا مشتق ولا اتصال خارج الحاوية؛ لم يُقَس ترميز غير مدعوم ولا رسالة الرفض على الهاتف ولا ملف تالف حقيقي من هاتف؛ مستمع الاتصال الخارجي يثبت أن شيئًا لم يخرج لكنه ليس كاشفًا مجرَّبًا (FFmpeg الافتراضي لا يجلب مقاطع http من قائمة محلية أصلًا)؛ طبقة المنع نفسها (protocol_whitelist) اختبارها في workers/media`);

    const docs = [doc, doc2];
    if (align) {
      const alignFails = fails.filter((f) => /^alignment:/.test(f));
      const doc3 = newResult("timestamp-alignment", { device, upload_path: tusUrl ? "tusd" : "n/a", file: { duration_s: 30, codec: "h264", vfr: true, hdr: false } });
      doc3.started_at = started;
      finish(doc3, alignFails.length ? "fail" : "partial", { offset_error_ms: Number(align.error_ms.toFixed(2)), truth_offset_ms: Number(align.truth_ms.toFixed(1)), confidence: align.confidence, threshold_ms: TOLERANCE_MS, failures: alignFails.length },
        `${alignFails.length ? `فشل: ${alignFails.join("؛ ")}. ` : ""}محاذاة صوتية من الطرف إلى الطرف في المكدس: نسخة هاتف 240p (تبدأ بعد الأصل بمقدار معلوم وطوابعها مصفَّرة) تُرفع أولًا ثم الأصل (30 ث بمعدل متغير وبداية 3.5 ث وصوت ضجيج بغلاف متغير)؛ يُنتظر أن يسجّل الخادم الإزاحة، ويُقارن بالمبنية عمدًا، ويظهر في Material.files أرقامًا فقط. partial: مقطع واحد اصطناعي، ولا هاتف حقيقي (الشق الميداني tools/acceptance/field/timestamp-alignment.md)، وترتيب الرفع هنا الأصل بعد النسخة فقط (الترتيب المعاكس ومرور الملفين معًا غير مقيسين)`);
      docs.push(doc3);
    }
    if (args["dry-run"]) { for (const d of docs) writeResult(d, { dryRun: true }); }
    else {
      const dir = args["out-dir"] && args["out-dir"] !== true ? args["out-dir"] : undefined;
      for (const d of docs) console.log("wrote", writeResult(d, { slug: "media-e2e", ...(dir ? { dir } : {}) }));
    }
    return { code: fails.length ? 1 : 0, doc, extra: doc2 };
  } finally {
    callout?.close();
    await pool.end();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { code } = await run();
  process.exit(code);
}
