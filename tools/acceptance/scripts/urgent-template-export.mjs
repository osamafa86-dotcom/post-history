// urgent-template-export — plan row «تصدير القالب العاجل»: the identity layers composited onto a two-minute 1080p clip in less
// time than the clip lasts, on the approved export server. Measured end to end through the product, not a bench: a synthetic
// 1920×1080 clip is uploaded as a reporter would (tus), the server verifies it, a supervisor requests a copy on the render
// template (circulated or witness, ADR 0091 and 0109: Remotion layers composited by FFmpeg in the media worker), and the
// render's own timestamps give the export time (started_at → completed_at) and the queue wait (requested_at → started_at).
// The stack needs the media worker with MEDIA_ENABLE_RENDERS on (the preview and the trial host have it; the CI compose does
// not, so this row is not run in CI). The verdict is about the approved export server only: a run elsewhere is partial.
//   UTX_API_URL=https://…/v1  UTX_TUS_URL=https://…/files/  UTX_TOKENS='{"reporter":"…","supervisor":"…"}'
//   [UTX_APPROVED_SERVER=1 when the stack runs on the approved export server]  [UTX_SERVER_LABEL="8 vCPU, no GPU"]
//   [UTX_TEMPLATE=circulated|witness] [UTX_ASPECT=horizontal|vertical|square] [UTX_SECONDS=120] [UTX_TIMEOUT_S=900]
//   INGEST_SIGNING_KEY / INGEST_KID when the stack's ingest gate needs a token (lib/ingest.mjs)
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, materialBody } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { tusAuth } from "../lib/ingest.mjs";
import { durationSeconds, sha256File, synthClip } from "../lib/media-clips.mjs";

/**
 * The row's verdict from one render: a failed render fails; a ready one under the clip's duration passes only on the approved
 * export server (elsewhere it is partial); over the duration it fails on the approved server and is partial elsewhere.
 */
export function judgeExport({ state, durationS, exportS, approved }) {
  if (state !== "ready") return { result: "fail", reason: `انتهت النسخة ${state ?? "بلا جواب"}` };
  if (!(durationS > 0) || !(exportS >= 0)) return { result: "fail", reason: "لا طوابع زمنية صالحة على النسخة" };
  const within = exportS < durationS;
  if (approved) return within ? { result: "pass", reason: "أقل من مدة المقطع على خادم التصدير المعتمد" } : { result: "fail", reason: "أطول من مدة المقطع على خادم التصدير المعتمد" };
  return { result: "partial", reason: `جزئي: ${within ? "أقل" : "أطول"} من مدة المقطع، لكن ليس على خادم التصدير المعتمد` };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("urgent-template-export"));
  const need = ["UTX_API_URL", "UTX_TUS_URL", "UTX_TOKENS"].filter((k) => !env[k]);
  if (need.length) { console.error(`ENVIRONMENT: missing ${need.join(", ")}; nothing measured (a stack with the media worker and MEDIA_ENABLE_RENDERS)`); return { code: 2, doc: null }; }
  const tokens = JSON.parse(env.UTX_TOKENS);
  if (!tokens.reporter || !tokens.supervisor) { console.error("ENVIRONMENT: UTX_TOKENS needs reporter and supervisor; nothing measured"); return { code: 2, doc: null }; }
  const seconds = Number(env.UTX_SECONDS ?? 120), timeoutMs = Number(env.UTX_TIMEOUT_S ?? 900) * 1000;
  const template = env.UTX_TEMPLATE ?? "circulated", aspect = env.UTX_ASPECT ?? "horizontal";
  const approved = env.UTX_APPROVED_SERVER === "1";
  const api = client(env.UTX_API_URL);
  const work = mkdtempSync(join(tmpdir(), "urgent-template-"));
  const fails = [];
  const check = (name, ok, why = "") => { if (!ok) { fails.push(`${name}${why ? `: ${why}` : ""}`); console.log(`FAIL ${name} ${why}`); } else console.log(`ok   ${name}`); return ok; };
  let doc = null, metrics = {}, verdict = null;
  try {
    // a synthetic two-minute 1080p30 clip, no planted tags (this row measures time, delivery-leak and c2pa measure tags)
    const path = synthClip(join(work, "urgent.mp4"), { seconds, size: "1920x1080", tags: false });
    const durationS = durationSeconds(path), size = statSync(path).size;
    doc = newResult("urgent-template-export", { device: { platform: "server", model: env.UTX_SERVER_LABEL ?? "server" }, upload_path: "tusd",
      file: { size_bytes: size, duration_s: Number(durationS.toFixed(3)), codec: "h264", vfr: false, hdr: false } });
    const fv = (await api.get(tokens.reporter, "/forms/current")).body?.version;
    const mat = await api.call(tokens.reporter, "POST", "/materials", { body: materialBody(fv, `urgent-template-${Date.now()}`) });
    if (!check("the material is created", mat.status === 201, `${mat.status}`)) throw new Error("no material");
    const session = await createUploadSession(api, tokens.reporter, { materialId: mat.body.id, size, clientSha256: await sha256File(path), filename: "urgent.mp4" });
    const up = await resumableUpload({ endpoint: env.UTX_TUS_URL, file: path, size, chunkSize: 8 * 1024 * 1024, interruptAt: [], metadata: { upload_session_id: session.id }, headers: () => tusAuth(session, env) });
    if (!check("the clip uploads without a resume violation", up.violations.length === 0, up.violations.join("; "))) throw new Error("upload");
    up.agentClose?.();
    const verified = (await waitFor(async () => { const r = (await api.get(tokens.reporter, `/uploads/${session.id}`)).body; return ["verified", "failed", "deduplicated"].includes(r?.state) ? r : null; }, { timeoutMs, everyMs: 1000 })).value;
    if (!check("the server verifies the original", verified?.state === "verified", `${verified?.state ?? "timeout"}`)) throw new Error("verification");

    const requested = await api.call(tokens.supervisor, "POST", `/materials/${mat.body.id}/renders`, { body: { template, aspect, title_lines: ["اختبار تصدير القالب"], show_location: false, label: "none" } });
    if (requested.status === 404) { console.error("ENVIRONMENT: the server does not serve renders (MEDIA_ENABLE_RENDERS off); nothing measured"); return { code: 2, doc: null }; }
    if (!check("the render is requested (202)", requested.status === 202, `${requested.status} ${requested.body?.code ?? ""}`)) throw new Error("render request");
    const render = (await waitFor(async () => {
      const list = (await api.get(tokens.supervisor, `/materials/${mat.body.id}/renders`)).body;
      const r = (list?.items ?? list ?? []).find?.((x) => x.id === requested.body.id);
      return r && ["ready", "failed"].includes(r.state) ? r : null;
    }, { timeoutMs, everyMs: 1000 })).value;
    const exportS = render?.started_at && render?.completed_at ? (Date.parse(render.completed_at) - Date.parse(render.started_at)) / 1000 : NaN;
    const queueS = render?.started_at ? (Date.parse(render.started_at) - Date.parse(render.requested_at)) / 1000 : NaN;
    verdict = judgeExport({ state: render?.state, durationS, exportS, approved });
    check("the render is ready with its file", render?.state === "ready" && Boolean(render?.file_id), `${render?.state ?? "timeout"} ${render?.failure_reason ?? ""}`);
    metrics = {
      template, aspect, clip_duration_s: Number(durationS.toFixed(2)), export_s: Number.isFinite(exportS) ? Number(exportS.toFixed(2)) : -1,
      export_to_duration: Number.isFinite(exportS) ? Number((exportS / durationS).toFixed(3)) : -1, queue_s: Number.isFinite(queueS) ? Number(queueS.toFixed(2)) : -1,
      within_duration: Number.isFinite(exportS) && exportS < durationS, approved_export_server: approved,
    };
  } catch (e) {
    if (!fails.length) fails.push(`aborted: ${String(e.message).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 200)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  doc ??= newResult("urgent-template-export", { device: { platform: "server", model: env.UTX_SERVER_LABEL ?? "server" }, upload_path: "tusd" });
  const result = fails.length ? "fail" : verdict.result;
  finish(doc, result, { ...metrics, checks_failed: fails.length }, fails.length ? fails.join("؛ ") : [
    `مقطع اصطناعي ${metrics.clip_duration_s} ث بدقة 1080p30 رُفع بـ tus وتحقق منه الخادم، ثم نسخة على قالب «${template === "witness" ? "الشاهد" : "مواد متداولة"}» (${aspect}) بطبقات Remotion يركّبها FFmpeg في عامل الوسائط`,
    `زمن التصدير من التقاط العامل إلى الجاهزية ${metrics.export_s} ث (${metrics.export_to_duration} من مدة المقطع)، وانتظار الطابور ${metrics.queue_s} ث`,
    verdict.reason,
  ].join("؛ "));
  if (args["dry-run"]) writeResult(doc, { dryRun: true });
  else console.log("wrote", writeResult(doc, { slug: `${template}-${aspect}` }));
  return { code: result === "fail" ? 1 : 0, doc };
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
