// delivery-leak: the buyer's delivery package (media_worker.delivery.build_delivery, signed C2PA as media_worker.jobs does) must carry nothing
// that reveals the source. Synthetic clips with revealing container tags, a GPS position and (phone clip) an SEI message are delivered with
// original + audio + stills, every file signed, and the package is judged from outside, with the whitelist and the c2patool call of
// scripts/c2pa-manifest.mjs (not the worker's own check):
//   - the package holds exactly: original.<ext>, audio.wav, stills/still_01..05.jpg, manifest.json, SHA256SUMS; every sum matches;
//   - every media file carries one C2PA manifest inside the closed list (opaque source reference only, the network as publisher, no thumbnail);
//   - no planted value, position-like text or the original's SHA-256 (hex, raw bytes, base64) in any entry of the package, manifest.json included;
//   - no planted value in the tags ffprobe reads; the original is byte-identical afterwards;
//   - controls: the planted values are in the source before delivery; a package with a leak injected is rejected.
// ALWAYS `partial`: a throw-away test root (no real trust list), the signing module (`signer_path`) not exercised, no real reporter file.
//   node scripts/delivery-leak.mjs [--dry-run]   (needs ffmpeg with libx265, ffprobe, python3, openssl, c2patool 0.28.x; the worker's code is imported)
//   C2PATOOL_BIN, WORKER_SRC as for c2pa-manifest
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { checker } from "../lib/core-gate.mjs";
import { LEAK_VALUES, SEI_VALUE, plantSei, rotateClip, sha256File, synthClip, synthHdrClip, tagDump } from "../lib/media-clips.mjs";
import { checkSums, readZip } from "../lib/export-package.mjs";
import { byteLeaks, judgeManifest, makeTestChain, readManifest } from "./c2pa-manifest.mjs";

const WORKER_SRC = process.env.WORKER_SRC ?? join(ROOT, "workers/media/src");
const C2PATOOL = process.env.C2PATOOL_BIN ?? "c2patool";
const SECRET = "acceptance-only-c2pa-source-secret-0123456789";
const PUBLISHER = "Test Network";
const LICENSE = "1c000000-0000-4000-8000-000000000001";
const EXPECTED = ["original.mov", "audio.wav", "manifest.json", "SHA256SUMS", ...[1, 2, 3, 4, 5].map((i) => `stills/still_0${i}.jpg`)];

const WORKER_DELIVER = `import json, os
from pathlib import Path
from media_worker import c2pa
from media_worker.delivery import build_delivery
from media_worker.hashing import digest_file
from media_worker.probe import probe
src, out, d = Path(os.environ["D_ORIGINAL"]), Path(os.environ["D_OUT"]), Path(os.environ["D_CERTS"])
info = probe(src); sha = digest_file(src).sha256
ref = c2pa.source_ref(os.environ["D_SECRET"].encode(), sha)
signer = c2pa.Signer(cert_chain=d / "chain.pem", private_key=d / "leaf.key", trust_anchors=d / "ca.pem")
def sign(path, actions):
    signed = path.with_name("c2pa-" + path.name)
    c2pa.sign(path, signed, signer=signer, title=signed.name, source=ref, actions=actions, publisher=os.environ["D_PUBLISHER"], version="1")
    return signed
build_delivery(out, original=src, info=info, license_id=os.environ["D_LICENSE"], sha256=sha, deliverables=["original", "audio", "stills"], sign=sign)
print(json.dumps({"source": ref, "sha256": sha}))`;

const have = (bin, flag = "-version") => spawnSync(bin, [flag], { stdio: "ignore" }).status === 0;

/** Judges one delivered package (entries: Map name -> Buffer). Returns the problems; `judgeFile(name, buffer)` returns manifest problems for a media file. */
export function judgePackage(entries, { planted, sha256, judgeFile }) {
  const bad = [];
  const names = [...entries.keys()].sort();
  if (names.join() !== [...EXPECTED].sort().join()) bad.push(`unexpected package contents: ${names.join(",")}`);
  for (const [name, buf] of entries) {
    for (const leak of byteLeaks(buf, { planted, sha256 })) bad.push(`${name}: ${leak}`);
    if (/\.(jpg|wav|mov|mp4)$/.test(name)) for (const p of judgeFile(name, buf)) bad.push(`${name}: ${p}`);
  }
  return bad;
}

export async function run(env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const doc = newResult("delivery-leak", { role: "quality", upload_path: "n/a", file: { codec: "synthetic H.264 phone clip (tags, GPS, SEI) and HEVC 10-bit HLG clip (tags, GPS), delivered with original, audio and stills" } });
  banner(byName("delivery-leak"));
  const { check, fails } = checker();
  const missing = [];
  if (!have(env.FFMPEG_BIN ?? "ffmpeg")) missing.push("ffmpeg");
  if (!have("openssl", "version")) missing.push("openssl");
  if (!have("python3", "--version")) missing.push("python3");
  if (!have(C2PATOOL, "--version")) missing.push(`c2patool (${C2PATOOL})`);
  if (!existsSync(join(WORKER_SRC, "media_worker/delivery.py"))) missing.push(`${WORKER_SRC}/media_worker/delivery.py`);
  if (missing.length) throw new Error(`delivery-leak needs: ${missing.join(", ")}`);

  const dir = mkdtempSync(join(tmpdir(), "delivery-leak-"));
  const metrics = {};
  try {
    const certs = join(dir, "certs"); mkdirSync(certs); makeTestChain(certs);
    const phone = plantSei(rotateClip(synthClip(join(dir, "phone-plain.mp4"), { seconds: 4, size: "1280x720", tags: true }), join(dir, "phone-rot.mov"), 90), join(dir, "phone.mov"));
    const hdr = synthHdrClip(join(dir, "hdr.mov"), { seconds: 3 });
    const cases = [
      { label: "phone H.264 (tags, GPS, SEI)", original: phone, planted: [...LEAK_VALUES, SEI_VALUE] },
      { label: "HDR HEVC HLG (tags, GPS)", original: hdr, planted: [...LEAK_VALUES] },
    ];
    let n = 0;
    for (const k of cases) {
      n += 1;
      const before = await sha256File(k.original);
      const bytes = readFileSync(k.original);
      check(`${k.label}: control: every planted value is in the source before delivery`, k.planted.every((v) => bytes.includes(Buffer.from(v))));
      const outDir = join(dir, `out-${n}`); mkdirSync(outDir);
      const out = join(outDir, "delivery.zip");
      const r = spawnSync("python3", ["-c", WORKER_DELIVER], {
        cwd: outDir, encoding: "utf8",
        env: { ...env, PYTHONPATH: WORKER_SRC, C2PATOOL_BIN: C2PATOOL, D_ORIGINAL: k.original, D_OUT: out, D_CERTS: certs, D_SECRET: SECRET, D_PUBLISHER: PUBLISHER, D_LICENSE: LICENSE },
      });
      if (r.status !== 0) { check(`${k.label}: the worker builds and signs the delivery package`, false, (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")); continue; }
      const info = JSON.parse(r.stdout.trim().split("\n").pop());
      const entries = readZip(out);
      const sums = checkSums(entries);
      check(`${k.label}: every file matches SHA256SUMS`, sums.ok, sums.problems.join("; "));
      const judgeFile = (name, buf) => {
        const f = join(outDir, `check-${name.replace(/\//g, "_")}`);
        writeFileSync(f, buf);
        const problems = judgeManifest(readManifest(f, certs), { source: info.source, sha256: info.sha256, planted: k.planted });
        if (k.planted.some((v) => tagDump(f).includes(v))) problems.push("planted value in the tags ffprobe reads");
        return problems;
      };
      const problems = judgePackage(entries, { planted: k.planted, sha256: info.sha256, judgeFile });
      check(`${k.label}: the package holds only the listed files, each signed inside the closed list, with no planted value, position or original digest anywhere`, problems.length === 0, problems.slice(0, 5).join("; "));
      // control: the judge is not vacuous
      const poisoned = new Map(entries); poisoned.set("manifest.json", Buffer.concat([entries.get("manifest.json"), Buffer.from(k.planted[0])]));
      check(`${k.label}: control: a package with a planted value injected is rejected`, judgePackage(poisoned, { planted: k.planted, sha256: info.sha256, judgeFile }).length > 0);
      check(`${k.label}: the original is byte-identical after delivery`, (await sha256File(k.original)) === before);
      metrics[`case${n}_files`] = entries.size;
    }
    metrics.cases = n;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const result = fails.length ? "fail" : "partial";
  const version = (() => { try { return execFileSync(C2PATOOL, ["--version"]).toString().trim(); } catch { return "unknown"; } })();
  finish(doc, result, { checks_failed: fails.length, ...metrics }, `حزمة تسليم المشتري (أصل وصوت وخمس صور، كلها موقَّعة C2PA) على مقطعين اصطناعيين بوسوم وموقع وSEI: محتويات الحزمة، والبصمات، وبيان كل ملف بقائمة بيضاء مكتوبة في السكربت، وغياب القيم المزروعة وأنماط الموقع وبصمة الأصل الخام من كل ملف فيها بما فيه manifest.json، والأصل لم يُمس، ورفض المقيّم لحزمة حُقنت فيها قيمة. لا pass: جذر الاختبار مؤقت (لا ثقة حقيقية)، ووحدة المفاتيح لم تُجرَّب، ولا ملف حقيقي. ${version}.`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "delivery-leak" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
