// transcript-draft (ticket 10): the local transcription worker end to end. A synthetic Arabic clip is uploaded; after the server verifies
// the original, the worker must register `transcript` (JSON) and `captions` (WebVTT) as derivatives of it.
//   TD_API_URL  TD_TUS_URL  TD_TOKENS {reporter}  TD_RUNS (5)  TD_CLIP_S (45)  TD_TIMEOUT_S (600)  TD_LIMIT_RATIO (1.0)
//   TD_SPEECH_FILE   a recording of Arabic speech to use instead of espeak-ng (public or synthetic audio only; never a reporter file). `pass` needs the pinned
//                    public clip (fixtures/td-speech.json: FLEURS, CC-BY-4.0; `node lib/speech-pin.mjs <dir>` fetches it and checks its sha256)
//   TD_TARGET_HOST   set to the trial host's name when this runs there; only then is the p95 ratio judged against the limit. On a shared runner the ratio is
//                    recorded as information (ratio_judged: false) and the result stays partial
//   TD_EGRESS_CMD    a shell command that tries to leave the worker container (e.g. `docker compose … exec -T ai-worker python3 -c "import socket; socket.create_connection(('1.1.1.1', 443), 3)"`); it must FAIL
//   AI_ENABLE_TRANSCRIPT=1  turns the script on (the worker and the server side are behind the same switch); without it the script is pending and writes nothing
// Per clip: the files listing gets both derivatives; the material's three states and title are exactly as they were at verification (the transcript is a draft,
// nothing is published); the JSON is a `draft`, `route: local`, language ar, timestamps on the original's timeline (inside the clip, ordered); the WebVTT is valid,
// every line starts with RLM, cues ordered and not overlapping; the bytes served by the signed links hash to the registered sha256. One extra clip is uploaded as a
// sensitivity-flagged material and goes through the same path, with `route: local`. Timing: from the server's verification to both derivatives registered, over the clip's
// duration, p95 across clips, against TD_LIMIT_RATIO. Not measured here: the accuracy of the words (that is tools/asr-bench), field recordings, GPU.
// `pass` needs: all runs, the sensitive clip, the bytes compared, TD_EGRESS_CMD given and refused, the pinned real-speech clip, and TD_TARGET_HOST; otherwise partial.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { client, createUploadSession, materialBody, percentile } from "../lib/live.mjs";
import { waitFor } from "../lib/hooks.mjs";
import { resumableUpload } from "../lib/tus.mjs";
import { tusAuth } from "../lib/ingest.mjs";
import { espeakArabic, sha256File, synthSpeechClip } from "../lib/media-clips.mjs";
import { scan, CHANNEL_KEYS } from "../lib/pii.mjs";
import { checker } from "../lib/core-gate.mjs";
import { EXIT_PENDING } from "../lib/pending.mjs";
import { freshFetch } from "../lib/http.mjs";
import { isPinnedSpeech } from "../lib/speech-pin.mjs";

const RLM = "‏";
const TIMING = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
const seconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
const TEXT = "هذه نشرة تجريبية لاختبار التفريغ المحلي. تتحدث النشرة عن الطقس في المدن الساحلية وعن حركة الأسواق صباح اليوم وعن موعد افتتاح المكتبة العامة.";

/** Problems in a transcript.json document (the worker's draft), for a clip of `durationS` seconds. */
export function checkTranscript(doc, { durationS, slack = 1.5 }) {
  const bad = [];
  if (!doc || typeof doc !== "object") return ["not a JSON object"];
  if (doc.format_version !== 1) bad.push(`format_version ${doc.format_version}`);
  if (doc.status !== "draft") bad.push(`status ${doc.status} (must be draft)`);
  if (doc.language !== "ar") bad.push(`language ${doc.language}`);
  if (doc.route !== "local") bad.push(`route ${doc.route} (must be local)`);
  if (!(Math.abs(doc.duration_s - durationS) <= slack)) bad.push(`duration_s ${doc.duration_s} vs the clip's ${durationS}`);
  if (!Number.isInteger(doc.start_pts_us)) bad.push("start_pts_us is not an integer");
  if (doc.source?.from !== "proxy-480p.mp4") bad.push(`source ${doc.source?.from}`);
  if (!Array.isArray(doc.segments)) return [...bad, "segments missing"];
  let prev = -1;
  doc.segments.forEach((s, i) => {
    if (!(s.start >= 0 && s.end >= s.start && s.end <= durationS + slack)) bad.push(`segment ${i} outside the clip (${s.start}-${s.end})`);
    if (s.start < prev) bad.push(`segment ${i} starts before the previous one`);
    prev = s.start;
    for (const w of s.words ?? []) if (!(w.start >= 0 && w.end >= w.start && w.end <= durationS + slack)) { bad.push(`a word of segment ${i} is outside the clip`); break; }
  });
  if (scan(doc, { keys: CHANNEL_KEYS }).length) bad.push("a revealing key or value in the transcript");
  return bad;
}

/** Problems in a WebVTT draft: header, cue timing format and order, RLM on every text line, no "-->" inside text. */
export function checkWebvtt(text) {
  const bad = [];
  if (!text.startsWith("WEBVTT")) return ["no WEBVTT header"];
  const blocks = text.split(/\n\n+/).slice(1).map((b) => b.trim()).filter(Boolean);
  let prevStart = -1, prevEnd = -1;
  blocks.forEach((b, i) => {
    const lines = b.split("\n");
    const m = TIMING.exec(lines[1] ?? "");
    if (!/^\d+$/.test(lines[0]) || !m) { bad.push(`cue ${i + 1} is malformed`); return; }
    const start = seconds(...m.slice(1, 5)), end = seconds(...m.slice(5, 9));
    if (!(end > start)) bad.push(`cue ${i + 1} ends before it starts`);
    if (start < prevStart || start < prevEnd - 0.001) bad.push(`cue ${i + 1} overlaps or precedes the previous cue`);
    prevStart = start; prevEnd = end;
    const body = lines.slice(2);
    if (!body.length) bad.push(`cue ${i + 1} has no text`);
    if (body.some((l) => !l.startsWith(RLM))) bad.push(`cue ${i + 1}: a text line without the RLM mark`);
    if (body.some((l) => l.includes("-->"))) bad.push(`cue ${i + 1}: "-->" inside the text`);
  });
  return bad;
}

export async function run(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  banner(byName("transcript-draft"));
  if (env.AI_ENABLE_TRANSCRIPT !== "1") {
    console.log("PENDING: transcript-draft is behind AI_ENABLE_TRANSCRIPT=1 until the worker runs in the stack; nothing measured");
    return { code: EXIT_PENDING, doc: null };
  }
  if (!env.TD_API_URL || !env.TD_TUS_URL) { console.error("ENVIRONMENT: TD_API_URL and TD_TUS_URL are required; nothing measured"); return { code: 2, doc: null }; }
  const token = JSON.parse(env.TD_TOKENS ?? "{}").reporter;
  const http = client(env.TD_API_URL, deps.fetchImpl ?? freshFetch);
  const doc = newResult("transcript-draft", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const runs = Number(env.TD_RUNS ?? 5), clipS = Number(env.TD_CLIP_S ?? 45), timeoutMs = Number(env.TD_TIMEOUT_S ?? 600) * 1000, limit = Number(env.TD_LIMIT_RATIO ?? 1);
  const work = mkdtempSync(join(tmpdir(), "transcript-draft-"));
  const ratios = [];
  let fetched = 0, sensitiveDone = false, words = 0, comparable = 0;
  try {
    let speech = env.TD_SPEECH_FILE;
    if (!speech) {
      try { speech = espeakArabic(join(work, "speech.wav"), TEXT); }
      catch { console.error("ENVIRONMENT: no TD_SPEECH_FILE and espeak-ng is not installed; nothing measured"); return { code: 2, doc: null }; }
    }
    const pinnedSpeech = await isPinnedSpeech(speech);
    if (env.TD_SPEECH_FILE && !pinnedSpeech) console.log("note TD_SPEECH_FILE is not the pinned clip (fixtures/td-speech.json): the result cannot be pass");
    const fv = (await http.get(token, "/forms/current")).body.version;
    const one = async (label, { sensitive = false } = {}) => {
      const mat = (await http.call(token, "POST", "/materials", { body: materialBody(fv, `transcript-draft-${label}-${Date.now()}`, sensitive ? { sensitivity: { minors: true, injured: false, graphic: false } } : {}) })).body;
      const clip = synthSpeechClip(join(work, `${label}.mov`), { speech, seconds: clipS });
      const size = readFileSync(clip).length;
      const session = await createUploadSession(http, token, { materialId: mat.id, size, clientSha256: await sha256File(clip), filename: `${label}.mov` });
      const up = await resumableUpload({ endpoint: env.TD_TUS_URL, file: clip, size, chunkSize: 8 * 1024 * 1024, interruptAt: [], metadata: { upload_session_id: session.id }, headers: () => tusAuth(session) });
      if (up.violations.length) throw new Error(`tus violations: ${up.violations.join("; ")}`);
      const verified = await waitFor(async () => (await http.get(token, `/uploads/${session.id}`)).body?.state === "verified", { timeoutMs, everyMs: 500 });
      check(`${label}: the server verifies the original`, verified.value === true);
      if (!verified.value) return;
      const t0 = Date.now();
      const view = async () => (await http.get(token, `/materials/${mat.id}`)).body;
      const before = await view();
      const files = await waitFor(async () => { const f = (await view()).files ?? []; const t = f.find((x) => x.kind === "transcript"), c = f.find((x) => x.kind === "captions"); return t && c ? { t, c } : null; }, { timeoutMs, everyMs: 500 });
      check(`${label}: transcript and captions are registered as derivatives`, Boolean(files.value));
      if (!files.value) return;
      if (!sensitive) ratios.push(((Date.now() - t0) / 1000) / clipS);
      const after = await view();
      const same = ["title", "technical_state", "editorial_state", "rights_state", "priority"].every((k) => JSON.stringify(before[k]) === JSON.stringify(after[k]));
      check(`${label}: the draft changes nothing of the material (title, the three states, priority)`, same);
      const read = async (f) => {
        const g = await http.call(token, "GET", `/materials/${mat.id}/files/${f.id}/download-url`);
        if (g.status !== 200) { check(`${label}: a download link for ${f.kind}`, false, String(g.status)); return null; }
        try {
          const res = await (deps.fetchImpl ?? freshFetch)(g.body.url);
          if (res.status !== 200) { check(`${label}: the ${f.kind} link is readable`, false, String(res.status)); return null; }
          const buf = Buffer.from(await res.arrayBuffer());
          check(`${label}: the ${f.kind} bytes hash to the registered sha256`, createHash("sha256").update(buf).digest("hex") === f.sha256);
          return buf.toString("utf8");
        } catch (e) { console.log(`note the ${f.kind} link is not reachable from here (${e.cause?.code ?? e.message})`); return null; }
      };
      const [jsonText, vttText] = [await read(files.value.t), await read(files.value.c)];
      if (jsonText !== null && vttText !== null) {
        fetched++;
        let parsed = null;
        try { parsed = JSON.parse(jsonText); } catch { /* reported below */ }
        const bad = parsed ? checkTranscript(parsed, { durationS: clipS }) : ["not JSON"];
        check(`${label}: the transcript is a local draft on the original's timeline`, bad.length === 0, bad.join("; "));
        const vbad = checkWebvtt(vttText);
        check(`${label}: the WebVTT is valid and right-to-left`, vbad.length === 0, vbad.join("; "));
        const n = (parsed?.segments ?? []).reduce((a, s) => a + (s.words?.length ?? 0), 0);
        words += n; comparable++;
        check(`${label}: the speech produced words`, n > 0, "no words recognised");
      }
      if (sensitive) sensitiveDone = true;
    };
    for (let i = 0; i < runs; i++) await one(`clip${i}`);
    await one("sensitive", { sensitive: true });

    let egressRefused = false;
    if (env.TD_EGRESS_CMD) {
      const r = spawnSync("bash", ["-c", env.TD_EGRESS_CMD], { encoding: "utf8", timeout: 60_000 });
      const notStarted = r.error || r.status === 127 || /No such container|is not running|command not found|executable file not found|OCI runtime exec failed/i.test(`${r.stderr}`);
      egressRefused = !notStarted && r.status !== 0;
      check("the worker container cannot reach outside (the egress command fails)", egressRefused, `exit ${r.status} ${String(r.stderr).slice(0, 100)}`);
    } else console.log("note TD_EGRESS_CMD not given: the no-egress claim for the sensitive material is not measured here");

    ratios.sort((a, b) => a - b);
    const p95 = percentile(ratios, 95);
    const judged = Boolean(env.TD_TARGET_HOST);
    if (judged) check(`transcription time over clip duration, p95 ${p95?.toFixed(2) ?? "n/a"} (limit ${limit}, on ${env.TD_TARGET_HOST})`, p95 !== null && p95 <= limit);
    else console.log(`info transcription time over clip duration, p95 ${p95?.toFixed(2) ?? "n/a"}: not judged against ${limit} (TD_TARGET_HOST not given; a shared runner is not the trial host)`);
    const full = !fails.length && ratios.length >= 5 && sensitiveDone && comparable === runs + 1 && egressRefused && pinnedSpeech && judged;
    finish(doc, fails.length ? "fail" : full ? "pass" : "partial", {
      clips: runs, clip_s: clipS, ratio_p95: p95 === null ? "n/a" : Number(p95.toFixed(3)), ratio_limit: limit, ratio_judged: judged, speech_pinned: pinnedSpeech, sensitive_clip_done: sensitiveDone,
      contents_compared: comparable, words_recognised: words, egress_checked: Boolean(env.TD_EGRESS_CMD), egress_refused: egressRefused,
    }, `${runs} مقطع اصطناعي بكلام عربي (${pinnedSpeech ? "كلام حقيقي عام: FLEURS مثبّت ببصمته" : env.TD_SPEECH_FILE ? "ملف مُعطى غير المثبّت" : "espeak-ng"}) ومقطع لمادة موسومة بالحساسية؛ لا دقة كلمات هنا (ذلك tools/asr-bench) ولا تسجيلات ميدانية${full ? "" : "؛ لم يكتمل ما يلزم لـ pass (المحتوى المقارن أو التحقق من غياب الخروج أو عدد المقاطع أو الكلام المثبّت أو مضيف التجربة الذي يُحكم عليه الحد)"}`);
    if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "api" }));
    return { code: fails.length ? 1 : 0, doc };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
