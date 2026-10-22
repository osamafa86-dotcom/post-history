import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSums, leaks, parseEdl, parseFcpxml, readZip, sha256, tcFrames } from "../lib/export-package.mjs";
import { run as cutExport } from "../scripts/cut-export.mjs";
import { validateMeasurement } from "../lib/measurement.mjs";

const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const hasTool = (bin) => spawnSync(bin, ["-version"], { stdio: "ignore" }).status === 0;
const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** A package the way the worker writes it (stored clip, deflated sidecars), built by Python's zipfile. */
function makeZip(dir, files, { sums = true } = {}) {
  const spec = join(dir, "spec.json"), out = join(dir, "pkg.zip");
  const list = Object.entries(files).map(([name, text]) => ({ name, hex: Buffer.from(text).toString("hex") }));
  writeFileSync(spec, JSON.stringify({ list, sums }));
  execFileSync("python3", ["-c", `import json, zipfile, hashlib, sys
spec = json.load(open(sys.argv[1])); files = [(e["name"], bytes.fromhex(e["hex"])) for e in spec["list"]]
with zipfile.ZipFile(sys.argv[2], "w") as z:
    for n, b in files: z.writestr(zipfile.ZipInfo(n), b, compress_type=zipfile.ZIP_STORED if n.startswith("clip") else zipfile.ZIP_DEFLATED)
    if spec["sums"]: z.writestr("SHA256SUMS", "".join(f"{hashlib.sha256(b).hexdigest()}  {n}\\n" for n, b in files))`, spec, out]);
  return out;
}

test("readZip reads stored and deflated entries and checkSums holds only when every file matches", { skip: !hasPython }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pkg-test-"));
  try {
    const files = { "clip.mov": "x".repeat(5000), "metadata.json": "{}".repeat(2000), "sequence.edl": "TITLE: t\n", "sequence.fcpxml": "<fcpxml/>" };
    const entries = readZip(makeZip(dir, files));
    assert.deepEqual([...entries.keys()].sort(), ["SHA256SUMS", "clip.mov", "metadata.json", "sequence.edl", "sequence.fcpxml"]);
    assert.equal(entries.get("metadata.json").toString(), files["metadata.json"]);
    assert.deepEqual(checkSums(entries), { ok: true, problems: [] });
    entries.set("clip.mov", Buffer.from("tampered"));
    assert.match(checkSums(entries).problems.join(), /clip\.mov does not match/);
    entries.set("extra.bin", Buffer.from("a"));
    assert.match(checkSums(entries).problems.join(), /extra\.bin is not in SHA256SUMS/);
    assert.equal(checkSums(readZip(makeZip(dir, files, { sums: false }))).ok, false, "a package without SHA256SUMS fails");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the EDL and FCPXML parsers read what the worker writes", () => {
  const edl = parseEdl("TITLE: f\nFCM: NON-DROP FRAME\n\n001  ORIGINAL AA/V   C        00:00:00:00 00:00:10:15 01:00:00:00 01:00:10:15\n* FROM CLIP NAME: clip.mov\n");
  assert.equal(edl.events.length, 1);
  assert.equal(edl.clip, "clip.mov");
  assert.equal(tcFrames(edl.events[0].srcOut, 30) - tcFrames(edl.events[0].srcIn, 30), 315);
  assert.equal(tcFrames(edl.events[0].recOut, 30) - tcFrames(edl.events[0].recIn, 30), 315);
  const fcp = parseFcpxml('<fcpxml><resources><format id="r1" frameDuration="1/30s" width="1920" height="1080"/><asset id="r2" duration="21/2s"><media-rep kind="original-media" src="clip.mov"/></asset></resources><library><sequence format="r1" duration="21/2s"><spine><asset-clip ref="r2" duration="21/2s"/></spine></sequence></library></fcpxml>');
  assert.deepEqual(fcp, { frameDuration: 1 / 30, sequenceDuration: 10.5, clipDuration: 10.5, src: "clip.mov" });
});

test("leaks finds planted values, location tags and GPS-shaped strings, and nothing in clean bytes", () => {
  const planted = ["AcceptanceMaker"];
  assert.deepEqual(leaks(new Map([["a", Buffer.from("clean sidecar {}")]]), planted), []);
  assert.deepEqual(leaks(new Map([["a", Buffer.from("xx AcceptanceMaker xx")]]), planted), ["a"]);
  assert.deepEqual(leaks(new Map([["b", Buffer.from("com.apple.quicktime.location.ISO6709")]]), planted), ["b"]);
  assert.deepEqual(leaks(new Map([["c", Buffer.from("loc +31.7767+035.2345+000.000/ end")]]), planted), ["c"]);
  assert.equal(sha256(Buffer.from("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("cut-export on synthetic phone and HDR clips: every check passes and the result stays partial", { skip: !(hasTool("ffmpeg") && hasTool("ffprobe") && hasPython) }, async () => {
  const { code, doc } = await quiet(() => cutExport(["--dry-run"], process.env));
  assert.equal(code, 0);
  assert.equal(doc.result, "partial", "no real editor cut, no import in an editor, no real phone file: never pass");
  assert.equal(doc.metrics.checks_failed, 0);
  assert.equal(doc.metrics.cases, 2);
  assert.equal(doc.metrics.render_cases, 2, "the final export is judged on both originals too");
  assert.ok(doc.metrics.case1_cut_max_gap_ms <= 40 && doc.metrics.case2_cut_max_gap_ms <= 40);
  assert.equal(validateMeasurement(doc).ok, true);
});

test("cut-export fails a package that kept the planted tags (the leak check has teeth)", { skip: !(hasTool("ffmpeg") && hasTool("ffprobe") && hasPython) }, async () => {
  const build = `d=$(dirname "$CUT_OUT"); cp "$CUT_ORIGINAL" "$d/clip.mov"; python3 - <<'P'
import os, zipfile, hashlib
d = os.path.dirname(os.environ["CUT_OUT"])
files = {"clip.mov": open(d + "/clip.mov", "rb").read(), "metadata.json": b"{}", "sequence.edl": b"TITLE: x\\n", "sequence.fcpxml": b"<fcpxml/>"}
with zipfile.ZipFile(os.environ["CUT_OUT"], "w") as z:
    for k, v in files.items(): z.writestr(k, v)
    z.writestr("SHA256SUMS", "".join(f"{hashlib.sha256(v).hexdigest()}  {k}\\n" for k, v in files.items()))
P`;
  const { code, doc } = await quiet(() => cutExport(["--dry-run"], { ...process.env, CUT_BUILD_CMD: build }));
  assert.equal(code, 1);
  assert.equal(doc.result, "fail");
  assert.ok(doc.metrics.checks_failed >= 4, `expected the leak and sequence checks to fail, got ${doc.metrics.checks_failed}`);
});
