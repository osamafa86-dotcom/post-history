// c2pa-manifest: the condition for switching MEDIA_ENABLE_C2PA on (ADR 0060). Clips with revealing tags, a GPS position and an SEI message
// planted in them go through the worker's own export (strip_metadata) and store-preview (watermark) paths, are signed by the worker's
// media_worker.c2pa.sign, and the signed file is then judged HERE, with a whitelist of our own and our own call to c2patool (the worker's
// check_report is not reused: a check that grades itself proves nothing):
//   - the manifest is read whole: one manifest, our generator, one ingredient that is only the opaque `post-history:source:` reference,
//     assertions and actions from the closed list, the network name as the only publisher, no key outside the list;
//   - no planted value, GPS pattern, nor the original's SHA-256 (hex, raw bytes or base64) anywhere in the manifest text or in the signed bytes;
//   - the signature validates against the test root and no validation code is open;
//   - the signed file is a new file (not the unsigned one, not the original), carries a C2PA box, and the original is byte-identical afterwards;
//   - controls: the planted values ARE in the original's bytes, and the judge rejects a manifest into which each kind of leak is injected.
// It is ALWAYS `partial`: the chain is a throw-away test root (openssl), so nothing here says "verified by a real trust list", the signing
// module (HSM/KMS, `signer_path`) is not exercised, and no real reporter file was used. `pass` needs the network's real certificate.
//   node scripts/c2pa-manifest.mjs [--dry-run]     (needs ffmpeg with libx265, ffprobe, python3, openssl, c2patool 0.28.x; the worker's code is imported)
//   C2PATOOL_BIN   path of c2patool (default: c2patool on PATH)
//   WORKER_SRC     the worker's source directory (default: workers/media/src)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";
import { checker } from "../lib/core-gate.mjs";
import { LEAK_VALUES, SEI_VALUE, plantSei, rotateClip, sha256File, synthClip, synthHdrClip, tagDump } from "../lib/media-clips.mjs";

const WORKER_SRC = process.env.WORKER_SRC ?? join(ROOT, "workers/media/src");
const C2PATOOL = process.env.C2PATOOL_BIN ?? "c2patool";
const GENERATOR = "post-history-media";
const SOURCE_PREFIX = "post-history:source:";
const PUBLISHER = "Test Network";
const SECRET = "acceptance-only-c2pa-source-secret-0123456789";
const WATERMARK_KEY = "acceptance-only-watermark-key-0123456789";

// The closed list, written out again on purpose (see the header).
const MANIFEST_KEYS = new Set(["claim_generator_info", "title", "instance_id", "ingredients", "assertions", "signature_info", "label", "format", "claim_version"]);
const SIGNATURE_KEYS = new Set(["alg", "issuer", "common_name", "cert_serial_number", "time"]);
const INGREDIENT_KEYS = new Set(["title", "format", "instance_id", "relationship", "label"]);
const ASSERTIONS = new Set(["c2pa.actions.v2", "stds.schema-org.CreativeWork", "c2pa.hash.bmff.v3", "c2pa.hash.bmff.v2", "c2pa.hash.data"]);
const ACTIONS = new Set(["c2pa.opened", "c2pa.transcoded", "c2pa.edited", "c2pa.color_adjustments"]);
const STEP_KEYS = new Set(["action", "parameters", "softwareAgent"]);
const POSITION = /[+-]\d{1,2}\.\d{2,}[+-]\d{1,3}\.\d{2,}/; // ISO 6709 shaped: scanned in the whole text, a digit pattern with dots does not occur in base64
// Words about a position are looked for in field names and in readable string values only. The report also holds signatures, hashes and
// certificate fields: base64 or hex blobs a few thousand characters long, in which "GPS" (three letters, either case) turns up by chance
// in about one manifest in ten, which made media e2e fail at random.
const GPS_WORDS = [/GPS/i, /\blat(itude)?\b/i, /\blon(gitude)?\b/i, /ISO6709/i];
const OPAQUE = /^[A-Za-z0-9+/=_-]{16,}$/;
/** Every key and every string value of a JSON document that is readable text, not an opaque blob. */
export function readableParts(node, out = []) {
  if (Array.isArray(node)) node.forEach((x) => readableParts(x, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { out.push(k); readableParts(v, out); }
  else if (typeof node === "string" && !OPAQUE.test(node)) out.push(node);
  return out;
}

const WORKER_SIGN = `import json, os
from pathlib import Path
from media_worker import c2pa
from media_worker.export import strip_metadata
from media_worker.hashing import digest_file
from media_worker.probe import probe
from media_worker.watermark import make_watermarked_preview
src, mode, out, d = Path(os.environ["C2_ORIGINAL"]), os.environ["C2_MODE"], Path(os.environ["C2_OUT"]), Path(os.environ["C2_CERTS"])
built = out.with_name("unsigned" + out.suffix)
if mode == "export":
    strip_metadata(src, built); actions = ["c2pa.transcoded"]
else:
    make_watermarked_preview(src, built, probe(src), os.environ["C2_WATERMARK_KEY"].encode(), "00000000-0000-4000-8000-000000000001")
    actions = ["c2pa.transcoded", "c2pa.edited"]
sha = digest_file(src).sha256
ref = c2pa.source_ref(os.environ["C2_SECRET"].encode(), sha)
signer = c2pa.Signer(cert_chain=d / "chain.pem", private_key=d / "leaf.key", trust_anchors=d / "ca.pem")
c2pa.sign(built, out, signer=signer, title=out.name, source=ref, actions=actions, publisher=os.environ["C2_PUBLISHER"], version="1")
print(json.dumps({"source": ref, "sha256": sha, "unsigned": str(built)}))`;

const have = (bin, flag = "-version") => spawnSync(bin, [flag], { stdio: "ignore" }).status === 0;

/** A throw-away P-256 root and a signing certificate, as the worker's own tests make them. Nothing is kept. */
export function makeTestChain(dir) {
  const ssl = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
  ssl("req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=Acceptance Root/O=test", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.pem");
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.ec");
  ssl("pkcs8", "-topk8", "-nocrypt", "-in", "leaf.ec", "-out", "leaf.key");
  ssl("req", "-new", "-key", "leaf.ec", "-subj", "/CN=Acceptance Signer/O=test", "-out", "leaf.csr");
  writeFileSync(join(dir, "ext.cnf"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=emailProtection\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n");
  ssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "ext.cnf", "-out", "leaf.pem");
  writeFileSync(join(dir, "chain.pem"), readFileSync(join(dir, "leaf.pem"), "utf8") + readFileSync(join(dir, "ca.pem"), "utf8"));
}

/** Our own read of a signed file: c2patool, no network (no OCSP, no remote manifest), trusting the test root. */
export function readManifest(file, dir) {
  const settings = join(dir, "read-settings.json");
  writeFileSync(settings, JSON.stringify({ version: 1, verify: { ocsp_fetch: false, remote_manifest_fetch: false, verify_trust: true }, trust: { trust_anchors: readFileSync(join(dir, "ca.pem"), "utf8") } }));
  const r = spawnSync(C2PATOOL, [file, "--settings", settings], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !r.stdout) throw new Error(`c2patool failed: ${(r.stderr || "").trim().split("\n").slice(-2).join(" | ")}`);
  return JSON.parse(r.stdout);
}

const hexOf = (s) => String(s).toLowerCase();
/** The original's SHA-256 in every form it could take in a text: hex, base64, base64url. */
export function shaForms(sha256) {
  const raw = Buffer.from(sha256, "hex");
  return [sha256, sha256.toUpperCase(), raw.toString("base64"), raw.toString("base64url")];
}

/**
 * Judge a c2patool report against the closed list. Returns the list of problems (empty = clean).
 * `planted` are the revealing values; `sha256` the original's digest; `source` the opaque reference the worker should have written.
 */
export function judgeManifest(report, { source, publisher = PUBLISHER, planted = [...LEAK_VALUES, SEI_VALUE], sha256, trusted = true }) {
  const bad = [];
  const manifests = report?.manifests ?? {}, active = report?.active_manifest;
  if (!active || Object.keys(manifests).length !== 1 || !manifests[active]) return [`exactly one manifest expected, got ${Object.keys(manifests).length}`];
  const codes = (report.validation_status ?? []).map((s) => s.code);
  if (codes.length) bad.push(`validation codes open: ${codes.join(",")}`);
  if (trusted && report.validation_state !== "Trusted") bad.push(`validation_state ${report.validation_state}, want Trusted against the test root`);
  const m = manifests[active];
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) bad.push(`manifest key ${k}`);
  for (const k of Object.keys(m.signature_info ?? {})) if (!SIGNATURE_KEYS.has(k)) bad.push(`signature key ${k}`);
  if (JSON.stringify((m.claim_generator_info ?? []).map((g) => g.name)) !== JSON.stringify([GENERATOR])) bad.push("claim generator is not ours alone");
  const ing = m.ingredients ?? [];
  if (ing.length !== 1) bad.push(`ingredients: ${ing.length}, want 1`);
  else {
    for (const k of Object.keys(ing[0])) if (!INGREDIENT_KEYS.has(k)) bad.push(`ingredient key ${k}`);
    if (ing[0].instance_id !== source || !String(ing[0].instance_id).startsWith(SOURCE_PREFIX)) bad.push("ingredient is not the opaque source reference");
    if (ing[0].relationship !== "parentOf") bad.push(`ingredient relationship ${ing[0].relationship}`);
  }
  let opened = false;
  for (const a of m.assertions ?? []) {
    if (!ASSERTIONS.has(a.label)) { bad.push(`assertion ${a.label}`); continue; }
    if (a.label === "c2pa.actions.v2") {
      const steps = a.data?.actions ?? [];
      opened = steps[0]?.action === "c2pa.opened";
      for (const s of steps) {
        if (!ACTIONS.has(s.action)) bad.push(`action ${s.action}`);
        for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) bad.push(`action key ${k}`);
        if (s.softwareAgent && s.softwareAgent.name !== GENERATOR) bad.push("softwareAgent is not ours");
      }
    }
    if (a.label === "stds.schema-org.CreativeWork") {
      const d = a.data ?? {};
      for (const k of Object.keys(d)) if (!["@context", "@type", "publisher"].includes(k)) bad.push(`CreativeWork key ${k}`);
      if (JSON.stringify(d.publisher) !== JSON.stringify({ "@type": "Organization", name: publisher })) bad.push("publisher is not the network name alone");
    }
  }
  if (!opened) bad.push("the first action is not c2pa.opened");
  const text = JSON.stringify(report), lower = hexOf(text);
  for (const v of planted) if (text.includes(v)) bad.push(`planted value in the manifest: ${v}`);
  if (POSITION.test(text)) bad.push(`position-like text in the manifest: ${POSITION}`);
  const readable = readableParts(report);
  for (const re of GPS_WORDS) if (readable.some((t) => re.test(t))) bad.push(`position-like text in the manifest: ${re}`);
  if (sha256) for (const f of shaForms(sha256)) if (text.includes(f) || lower.includes(hexOf(f))) bad.push("the original's SHA-256 is in the manifest");
  return bad;
}

/** Looks for planted values and the original's digest (hex, raw bytes) in the bytes of a file; UTF-8 and UTF-16 spellings of the text. */
export function byteLeaks(bytes, { planted, sha256 }) {
  const found = [];
  for (const v of planted) {
    for (const enc of ["utf8", "utf16le"]) if (bytes.includes(Buffer.from(v, enc))) found.push(`${v} (${enc})`);
  }
  if (sha256) {
    if (bytes.includes(Buffer.from(sha256, "hex"))) found.push("sha256 raw bytes");
    if (bytes.includes(Buffer.from(sha256))) found.push("sha256 hex");
  }
  return found;
}

export async function run(env = process.env, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const doc = newResult("c2pa-manifest", { role: "quality", upload_path: "n/a", file: { codec: "synthetic H.264 phone clip (tags, GPS, SEI) and HEVC 10-bit HLG clip (tags)" } });
  banner(byName("c2pa-manifest"));
  const { check, fails } = checker();
  const missing = [];
  if (!have(env.FFMPEG_BIN ?? "ffmpeg")) missing.push("ffmpeg");
  if (!have("openssl", "version")) missing.push("openssl");
  if (!have("python3", "--version")) missing.push("python3");
  if (!have(C2PATOOL, "--version")) missing.push(`c2patool (${C2PATOOL})`);
  if (!existsSync(join(WORKER_SRC, "media_worker/c2pa.py"))) missing.push(`${WORKER_SRC}/media_worker/c2pa.py (ADR 0060 signing)`);
  if (missing.length) throw new Error(`c2pa-manifest needs: ${missing.join(", ")}`);

  const dir = mkdtempSync(join(tmpdir(), "c2pa-manifest-"));
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
      const before = await sha256File(k.original);
      const bytes = readFileSync(k.original);
      check(`${k.label}: control: every planted value is in the original's bytes before signing`, k.planted.every((v) => bytes.includes(Buffer.from(v))), k.planted.filter((v) => !bytes.includes(Buffer.from(v))).join(","));
      for (const mode of ["export", "preview"]) {
        const label = `${k.label} / ${mode}`, outDir = join(dir, `out-${n}`); mkdirSync(outDir);
        const out = join(outDir, mode === "export" ? "signed.mov" : "signed.mp4"); n += 1;
        const r = spawnSync("python3", ["-c", WORKER_SIGN], {
          cwd: outDir, encoding: "utf8",
          env: { ...env, PYTHONPATH: WORKER_SRC, C2PATOOL_BIN: C2PATOOL, C2_ORIGINAL: k.original, C2_MODE: mode, C2_OUT: out, C2_CERTS: certs, C2_SECRET: SECRET, C2_WATERMARK_KEY: WATERMARK_KEY, C2_PUBLISHER: PUBLISHER },
        });
        if (r.status !== 0) { check(`${label}: the worker signs the file`, false, (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")); continue; }
        const info = JSON.parse(r.stdout.trim().split("\n").pop());
        check(`${label}: the signed output is a new file, not the unsigned one`, existsSync(out) && info.unsigned !== out && (await sha256File(out)) !== (await sha256File(info.unsigned)));
        const signed = readFileSync(out);
        check(`${label}: the signed file carries a C2PA box`, signed.includes(Buffer.from("c2pa")) && signed.includes(Buffer.from("jumb")));
        const report = readManifest(out, certs);
        const problems = judgeManifest(report, { source: info.source, sha256: info.sha256, planted: k.planted });
        check(`${label}: the manifest read whole is inside the closed list and clean`, problems.length === 0, problems.slice(0, 4).join("; "));
        const leaked = byteLeaks(signed, { planted: k.planted, sha256: info.sha256 });
        check(`${label}: no planted value or original digest in the signed file's bytes`, leaked.length === 0, leaked.join("; "));
        check(`${label}: no planted value in the signed file's tags (ffprobe)`, !k.planted.some((v) => tagDump(out).includes(v)));
        // negative controls: the judge is not vacuous. Each injected leak must be rejected.
        const poisons = {
          "a planted tag": (m) => m.assertions.push({ label: "c2pa.actions.v2", data: { actions: [{ action: "c2pa.opened" }], note: k.planted[0] } }),
          "an exif assertion": (m) => m.assertions.push({ label: "stds.exif", data: { "exif:GPSLatitude": "31.7" } }),
          "the raw digest": (m) => { m.ingredients[0].data = { hash: info.sha256 }; },
          "a second ingredient": (m) => m.ingredients.push({ title: "x", relationship: "componentOf" }),
          "a foreign publisher": (m) => { const cw = m.assertions.find((a) => a.label === "stds.schema-org.CreativeWork"); cw.data.publisher.name = "Someone Else"; },
        };
        const poisonedOk = Object.entries(poisons).map(([name, f]) => {
          const copy = structuredClone(report); f(copy.manifests[copy.active_manifest]);
          return [name, judgeManifest(copy, { source: info.source, sha256: info.sha256, planted: k.planted }).length > 0];
        });
        check(`${label}: control: the judge rejects ${poisonedOk.map(([nm]) => nm).join(", ")}`, poisonedOk.every(([, ok]) => ok), poisonedOk.filter(([, ok]) => !ok).map(([nm]) => nm).join(","));
        metrics[`signed${n}_bytes`] = signed.length;
      }
      check(`${k.label}: the original is byte-identical after signing`, (await sha256File(k.original)) === before);
    }
    metrics.signed_outputs = n;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const result = fails.length ? "fail" : "partial";
  const version = (() => { try { return execFileSync(C2PATOOL, ["--version"]).toString().trim(); } catch { return "unknown"; } })();
  finish(doc, result, { checks_failed: fails.length, ...metrics }, `توقيع C2PA (ADR 0060) على مقطعين اصطناعيين بوسوم وموقع (وSEI في مقطع الهاتف) عبر مساري التصدير ومعاينة المتجر: البيان يُقرأ كاملًا بقائمة بيضاء مكتوبة هنا لا بـ check_report، ولا قيمة مزروعة ولا بصمة الأصل في البيان ولا في بايتات الملف، والملف الموقَّع جديد، والأصل لم يُمس، ورفض المقيّم لتسريبات محقونة عمدًا. لا pass: سلسلة الاختبار جذر مؤقت من openssl فلا ثقة حقيقية، ووحدة المفاتيح (signer_path) لم تُجرَّب، ولا ملف حقيقي. ${version}.`);
  if (args["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "c2pa-manifest" }));
  return { code: fails.length ? 1 : 0, doc };
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit((await run()).code);
