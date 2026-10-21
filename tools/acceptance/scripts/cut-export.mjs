// cut-export: the editing-export package the media worker builds (workers/media/src/media_worker/export.py) hands an editor the
// original's footage intact. Measured on synthetic phone-style clips, never a real reporter file:
//   - the package holds clip.<ext>, metadata.json, sequence.fcpxml, sequence.edl and SHA256SUMS, nothing else, and every sum matches;
//   - the clip carries the original's streams unchanged: codec, size, pixel format, rotation, HDR colour tags, frame count;
//   - cut points: at 10 random frames of the original the clip's frame sits at the same time (<= 40 ms; the row's tolerance);
//   - audio/video offset in the clip equals the original's within 40 ms, and the first timestamps are kept (start_pts);
//   - the EDL and the FCPXML cover exactly the clip (duration within 40 ms, the clip named as in the package);
//   - no planted tag, GPS position or device model anywhere in the package, and the original is byte-identical afterwards.
// It is ALWAYS `partial`: a real editor cut (an in/out chosen by a person) does not exist in the core phase, the package was not
// imported in Resolve, Premiere or Final Cut, and no real phone file was measured. `pass` needs all three.
//   node scripts/cut-export.mjs [--dry-run]            (needs ffmpeg with libx265, ffprobe, python3; the worker's own code is imported)
//   CUT_BUILD_CMD   shell command that builds the package from $CUT_ORIGINAL into $CUT_OUT (default: the repository's media_worker)
//   CUT_PACKAGE + CUT_ORIGINAL   judge a package you already have instead of building one
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { checker } from "../lib/core-gate.mjs";
import { LEAK_VALUES, SEI_VALUE, plantSei, rotateClip, sha256File, synthClip, synthHdrClip, videoTimes, cutBack } from "../lib/media-clips.mjs";
import { checkSums, leaks, parseEdl, parseFcpxml, readZip, streamFacts, tcFrames } from "../lib/export-package.mjs";

const TOL_MS = 40;
const EXPECTED = ["SHA256SUMS", "metadata.json", "sequence.edl", "sequence.fcpxml"];

const WORKER_BUILD = `from pathlib import Path; import os
from media_worker.probe import probe
from media_worker.hashing import digest_file
from media_worker.export import build_package
o = Path(os.environ["CUT_ORIGINAL"]); d = digest_file(o)
build_package(Path(os.environ["CUT_OUT"]), original=o, info=probe(o), material_id="00000000-0000-4000-8000-000000000001",
              file_id="00000000-0000-4000-8000-000000000002", sha256=d.sha256, size_bytes=d.size_bytes, proxy=None)`;

function build(original, out, env) {
  const childEnv = { ...env, CUT_ORIGINAL: original, CUT_OUT: out, PYTHONPATH: join(ROOT, "workers/media/src") };
  const r = env.CUT_BUILD_CMD
    ? spawnSync("sh", ["-c", env.CUT_BUILD_CMD], { env: childEnv, encoding: "utf8" })
    : spawnSync("python3", ["-c", WORKER_BUILD], { env: childEnv, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`building the package failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
}

const have = (bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;

/** The checks for one original and its package. Returns the numbers that go into the result. */
export function judgeCase(label, { originalPath, packagePath, check, planted = [...LEAK_VALUES, SEI_VALUE], clipTimes = (p) => videoTimes(p), extract }) {
  const entries = readZip(packagePath);
  const clipName = [...entries.keys()].find((n) => /^clip\.[a-z0-9]+$/.test(n));
  check(`${label}: the package holds clip.<ext>, metadata.json, the two sequences and SHA256SUMS, nothing else`,
    Boolean(clipName) && [...entries.keys()].filter((n) => n !== clipName && n !== "proxy.mp4").sort().join() === EXPECTED.join(), [...entries.keys()].join(","));
  const sums = checkSums(entries);
  check(`${label}: every file matches SHA256SUMS`, sums.ok, sums.problems.join("; "));
  if (!clipName) return {};
  const clipPath = extract(clipName, entries.get(clipName));
  const o = streamFacts(originalPath), c = streamFacts(clipPath);
  const same = (k) => JSON.stringify(o.video?.[k]) === JSON.stringify(c.video?.[k]);
  check(`${label}: video codec, size and pixel format unchanged`, ["codec", "width", "height", "pix_fmt"].every(same), JSON.stringify([o.video, c.video]));
  check(`${label}: rotation unchanged`, same("rotation"), `${o.video?.rotation} vs ${c.video?.rotation}`);
  check(`${label}: HDR colour tags unchanged`, ["color_transfer", "color_primaries", "color_space"].every(same), JSON.stringify([o.video, c.video]));
  check(`${label}: every video frame and audio packet carried over`, o.video?.packets === c.video?.packets && o.audio?.packets === c.audio?.packets, `${o.video?.packets}/${c.video?.packets} ${o.audio?.packets}/${c.audio?.packets}`);

  const cut = cutBack(clipTimes(originalPath), clipTimes(clipPath));
  check(`${label}: cut points: 10 random frames sit at the same time in the clip (<= ${TOL_MS} ms, matched by position)`, cut.byIndex && cut.maxMs <= TOL_MS, `max ${cut.maxMs} ms, byIndex ${cut.byIndex}`);
  const firstDeltaMs = Math.abs(c.video.start_time - o.video.start_time) * 1000;
  check(`${label}: the first timestamp (start_pts) is kept`, firstDeltaMs <= 1, `${firstDeltaMs.toFixed(3)} ms`);
  const avO = (o.audio.start_time - o.video.start_time) * 1000, avC = (c.audio.start_time - c.video.start_time) * 1000;
  const avDelta = Math.abs(avC - avO);
  check(`${label}: audio/video offset in the clip equals the original's (<= ${TOL_MS} ms)`, avDelta <= TOL_MS, `${avO.toFixed(1)} vs ${avC.toFixed(1)} ms`);

  const edl = parseEdl(entries.get("sequence.edl")?.toString("utf8") ?? ""), fcp = parseFcpxml(entries.get("sequence.fcpxml")?.toString("utf8") ?? "");
  const ev = edl.events[0], base = ev && fcp.frameDuration ? Math.round(1 / fcp.frameDuration) : null;
  const edlSeconds = ev && base ? (tcFrames(ev.srcOut, base) - tcFrames(ev.srcIn, base)) / base : null;
  const recSeconds = ev && base ? (tcFrames(ev.recOut, base) - tcFrames(ev.recIn, base)) / base : null;
  check(`${label}: the EDL has one event naming the clip, source and record spans equal`, edl.events.length === 1 && edl.clip === clipName && edlSeconds === recSeconds, JSON.stringify(edl));
  const edlGapMs = edlSeconds === null ? Infinity : Math.abs(edlSeconds - c.duration) * 1000;
  const fcpGapMs = fcp.sequenceDuration === null ? Infinity : Math.abs(fcp.sequenceDuration - c.duration) * 1000;
  check(`${label}: the EDL and the FCPXML cover the clip (duration within ${TOL_MS} ms)`, edlGapMs <= TOL_MS && fcpGapMs <= TOL_MS && fcp.src === clipName && fcp.sequenceDuration === fcp.clipDuration, `edl ${edlGapMs} ms, fcpxml ${fcpGapMs} ms, src ${fcp.src}`);

  const found = leaks(new Map([...entries].map(([n, b]) => [n === clipName ? "clip (bytes)" : n, b])), planted);
  check(`${label}: no planted tag, GPS position or device model anywhere in the package`, found.length === 0, found.join(","));
  check(`${label}: the clip's container and stream tags are empty`, !planted.some((p) => c.tags.includes(p)) && !/ISO6709|quicktime/i.test(c.tags), c.tags.slice(0, 120));
  return { cut_max_gap_ms: cut.maxMs, first_pts_delta_ms: firstDeltaMs, av_offset_delta_ms: avDelta, edl_gap_ms: edlGapMs, fcpxml_gap_ms: fcpGapMs, frames: o.video?.packets };
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  banner(byName("cut-export"));
  const given = env.CUT_PACKAGE && env.CUT_ORIGINAL;
  if (!given && !(have("ffmpeg") && have("ffprobe") && spawnSync("python3", ["--version"]).status === 0)) {
    console.error("ENVIRONMENT: ffmpeg, ffprobe and python3 are needed to build and judge the package; nothing measured");
    return { code: 2, doc: null };
  }
  const doc = newResult("cut-export", { device: { platform: "server" }, upload_path: "n/a" });
  const { fails, check } = checker();
  const dir = mkdtempSync(join(tmpdir(), "cut-export-"));
  const extract = (name, buf) => { const p = join(dir, `extracted-${name}`); execFileSync("sh", ["-c", 'cat > "$1"', "sh", p], { input: buf, maxBuffer: 1 << 30 }); return p; };
  const metrics = {};
  const cases = [];
  try {
    if (given) cases.push({ label: "given", original: env.CUT_ORIGINAL, pkg: env.CUT_PACKAGE });
    else {
      const phone = synthClip(join(dir, "phone-plain.mp4"), { seconds: 20, size: "1920x1080", vfr: true, startOffset: 3.5, tags: true });
      cases.push({ label: "phone: VFR, first timestamp 3.5 s, rotated 90, planted tags and an SEI message", original: plantSei(rotateClip(phone, join(dir, "phone-rot.mov"), 90), join(dir, "phone.mov")) });
      const hdr = synthHdrClip(join(dir, "hdr.mov"), { seconds: 8 });
      cases.push({ label: "HDR: HEVC 10-bit BT.2020 HLG, planted tags", original: hdr });
    }
    for (const [i, k] of cases.entries()) {
      const before = await sha256File(k.original);
      let pkg = k.pkg;
      if (!pkg) { pkg = join(dir, `out-${i}`, "export.zip"); execFileSync("mkdir", ["-p", join(dir, `out-${i}`)]); build(k.original, pkg, env); }
      const m = judgeCase(k.label, { originalPath: k.original, packagePath: pkg, check, extract });
      check(`${k.label}: the original is byte-identical after the export`, (await sha256File(k.original)) === before);
      for (const [key, v] of Object.entries(m)) metrics[`case${i + 1}_${key}`] = Number(Number(v).toFixed(3));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const result = fails.length ? "fail" : "partial";
  const ffmpegVersion = (() => { try { return execFileSync("ffmpeg", ["-version"]).toString().split("\n")[0].split(" ")[2]; } catch { return "unknown"; } })();
  finish(doc, result, { cases: cases.length, checks_failed: fails.length, tolerance_ms: TOL_MS, ...metrics },
    `حزمة تصدير المونتاج على مقاطع اصطناعية بوسوم كاشفة مزروعة (${cases.length}): الحزمة والبصمات والتيارات والتدوير ووسوم HDR ونقاط القص العشر وإزاحة الصوت والتسلسلان وغياب الوسوم والأصل لم يُمس. لا pass: لا محرر في النواة فلا قص حقيقي بنقاط يختارها إنسان، والاستيراد لم يُجرَّب في Resolve وPremiere وFinal Cut، ولا ملف هاتف حقيقي. FFmpeg المشغِّل هو ما على الجهاز (${ffmpegVersion}) لا المثبّت في صورة العامل.`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "export-package" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
