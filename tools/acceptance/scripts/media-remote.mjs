// media-remote: the media pipeline against a REMOTE host, through the public API and tus only (the field-trial pack).
// media-e2e needs the database, the object storage and the worker's log; a remote host gives none of them. What the API shows is
// checked here: a phone-style clip verifies (server SHA-256 = the client's, receipt), the proxy appears in the material's files (the
// poster thumbnail is recorded, not required: the server does not register thumbnails yet), the revealing container tags planted in the clip surface nowhere in the API, and files dressed as video fail
// as `invalid_file` with no proxy. Recorded as `partial` under the same rows with a different device label: it never replaces media-e2e.
//   MEDIA_REMOTE_API_URL  MEDIA_REMOTE_TUS_URL  MEDIA_REMOTE_TOKEN (reporter)  MEDIA_REMOTE_TIMEOUT_S (240)  MEDIA_REMOTE_ENV_LABEL
// Not measured, and said so: cut accuracy (the proxy file is not reachable from here), the original's integrity in storage, the
// worker's log, the thumbnails' bytes, whether anything left the worker.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, materialBody } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { scan } from "../lib/pii.mjs";
import { LEAK_VALUES, hostilePayloads, sha256File, synthClip } from "../lib/media-clips.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("proxy-accuracy"));
  if (!env.MEDIA_REMOTE_API_URL || !env.MEDIA_REMOTE_TUS_URL || !env.MEDIA_REMOTE_TOKEN) {
    console.error("ENVIRONMENT: MEDIA_REMOTE_API_URL, MEDIA_REMOTE_TUS_URL and MEDIA_REMOTE_TOKEN are required; nothing measured");
    return { code: 2, doc: null };
  }
  const api = client(env.MEDIA_REMOTE_API_URL), token = env.MEDIA_REMOTE_TOKEN, tusUrl = env.MEDIA_REMOTE_TUS_URL;
  const timeoutMs = Number(env.MEDIA_REMOTE_TIMEOUT_S ?? 240) * 1000;
  const work = mkdtempSync(join(tmpdir(), "media-remote-"));
  const started = new Date().toISOString();
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); };
  try {
    const fv = (await api.get(token, "/forms/current")).body?.version;
    const submit = async (path, label) => {
      const mat = (await api.call(token, "POST", "/materials", { body: materialBody(fv, `media-remote-${label}-${Date.now()}`) })).body;
      const sha = await sha256File(path), size = readFileSync(path).length;
      const session = await createUploadSession(api, token, { materialId: mat.id, size, clientSha256: sha, filename: label });
      const up = await resumableUpload({ endpoint: tusUrl, file: path, size, chunkSize: 8 * 1024 * 1024, interruptAt: [], metadata: { upload_session_id: session.id }, headers: { Authorization: `Bearer ${session.token}` } });
      if (up.violations.length) throw new Error(`tus violations: ${up.violations.join("; ")}`);
      return { mat, session, sha };
    };
    const settle = async (sub) => (await waitFor(async () => {
      const r = (await api.get(token, `/uploads/${sub.session.id}`)).body;
      return ["verified", "failed", "deduplicated"].includes(r.state) ? r : null;
    }, { timeoutMs, everyMs: 500 })).value;
    const filesOf = async (id) => (await api.get(token, `/materials/${id}`)).body?.files ?? [];

    const clip = synthClip(join(work, "phone.mov"), { seconds: 20, vfr: true, gap: [8, 9], startOffset: 5 });
    const sub = await submit(clip, "phone.mov");
    const done = await settle(sub);
    check("phone clip: the session verifies", done?.state === "verified", `state ${done?.state ?? "timeout"}`);
    check("phone clip: the receipt number is issued", /^R-\d{6}-\d{6}$/.test(done?.receipt_number ?? ""), String(done?.receipt_number));
    const proxy = (await waitFor(async () => (await filesOf(sub.mat.id)).find((f) => f.kind === "proxy" && f.state === "verified") ?? null, { timeoutMs, everyMs: 500 })).value;
    check("phone clip: a verified proxy appears in the material's files", Boolean(proxy));
    const thumb = (await waitFor(async () => (await filesOf(sub.mat.id)).find((f) => f.kind === "thumbnail") ?? null, { timeoutMs: 60_000, everyMs: 1000 })).value;
    // not a check: the server does not accept kind=thumbnail on the derivatives endpoint yet (same finding as media-e2e); recorded
    console.log(`note ${thumb ? "the poster thumbnail is registered in the material's files" : "the poster thumbnail is NOT in the material's files (the server refuses kind=thumbnail)"}`);
    const dump = [(await api.get(token, `/materials/${sub.mat.id}`)).body, (await api.get(token, `/uploads/${sub.session.id}`)).body];
    const leaks = scan(dump, { canaries: LEAK_VALUES }).length;
    check("revealing tags planted in the clip surface nowhere in the API", leaks === 0, `${leaks} hit(s)`);

    const cases = hostilePayloads({ calloutUrl: "http://127.0.0.1:9/never" }).filter((h) => h.label !== "hls-callout");
    const whole = readFileSync(clip);
    writeFileSync(join(work, "truncated.mov"), whole.subarray(0, Math.floor(whole.length / 2)));
    const all = [...cases.map((h) => (writeFileSync(join(work, h.name), h.bytes), { label: h.label, path: join(work, h.name), name: h.name })), { label: "truncated-clip", path: join(work, "truncated.mov"), name: "truncated.mov" }];
    for (const c of all) {
      const s = await submit(c.path, c.name);
      const d = await settle(s);
      const files = await filesOf(s.mat.id);
      check(`${c.label}: failed as invalid_file with no proxy`, d?.state === "failed" && d.failure_reason === "invalid_file" && !files.some((f) => f.kind === "proxy"), `${d?.state}/${d?.failure_reason}`);
    }

    const device = { platform: "server", model: env.MEDIA_REMOTE_ENV_LABEL ?? "remote host, API and tus only" };
    const notMeasured = "لم يُقَس عن بُعد: دقة نقاط القص (ملف النسخة غير متاح)، وسلامة الأصل في التخزين، وسجل العامل، وبايتات المصغّرات، وخروج أي اتصال من العامل؛ تغطيها media-e2e على compose فقط";
    const doc = newResult("proxy-accuracy", { device, upload_path: "tusd" });
    doc.started_at = started;
    const proxyFails = fails.filter((f) => !/failed as invalid_file/.test(f));
    finish(doc, proxyFails.length ? "fail" : "partial", { phone_clip_verified: done?.state === "verified", proxy_in_files: Boolean(proxy), thumbnail_in_files: Boolean(thumb), leak_hits_api: leaks, failures: proxyFails.length }, `${proxyFails.length ? `فشل: ${proxyFails.join("؛ ")}. ` : ""}${notMeasured}`);
    const doc2 = newResult("invalid-file", { device, upload_path: "tusd" });
    doc2.started_at = started;
    const rejectFails = fails.filter((f) => /failed as invalid_file/.test(f));
    finish(doc2, rejectFails.length ? "fail" : "partial", { hostile_cases: all.length, hostile_cases_rejected: all.length - rejectFails.length, failures: rejectFails.length }, `${rejectFails.length ? `فشل: ${rejectFails.join("؛ ")}. ` : ""}${notMeasured}؛ مستمع الاتصال الخارجي غير ممكن عن بُعد`);
    if (args["dry-run"]) { writeResult(doc, { dryRun: true }); writeResult(doc2, { dryRun: true }); }
    else { console.log("wrote", writeResult(doc, { slug: "media-remote" })); console.log("wrote", writeResult(doc2, { slug: "media-remote" })); }
    return { code: fails.length ? 1 : 0, doc, extra: doc2 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { code } = await run();
  process.exit(code);
}
