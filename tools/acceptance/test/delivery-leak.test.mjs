import test from "node:test";
import assert from "node:assert/strict";
import { judgePackage } from "../scripts/delivery-leak.mjs";

const SHA = "ab".repeat(32), PLANTED = ["iPhone15,2", "AcceptanceSeiDevice-9f3a"];
const names = ["original.mov", "audio.wav", "manifest.json", "SHA256SUMS", ...[1, 2, 3, 4, 5].map((i) => `stills/still_0${i}.jpg`)];
const pkg = () => new Map(names.map((n) => [n, Buffer.from(`content of ${n}`)]));
const judge = (entries, files = () => []) => judgePackage(entries, { planted: PLANTED, sha256: SHA, judgeFile: files });

test("a package with the listed files and nothing revealing is clean", () => assert.deepEqual(judge(pkg()), []));

test("an extra or missing file is reported", () => {
  const extra = pkg(); extra.set("transcript.json", Buffer.from("x"));
  assert.ok(judge(extra).length > 0);
  const missing = pkg(); missing.delete("audio.wav");
  assert.ok(judge(missing).length > 0);
});

test("a planted value, the original digest (hex or raw) in any entry is reported", () => {
  for (const leak of [Buffer.from("iPhone15,2"), Buffer.from(SHA), Buffer.from(SHA, "hex")]) {
    const p = pkg(); p.set("manifest.json", Buffer.concat([p.get("manifest.json"), leak]));
    assert.ok(judge(p).length > 0);
  }
});

test("manifest problems of a media file are reported with the file name", () => {
  const bad = judge(pkg(), (name) => (name === "audio.wav" ? ["assertion stds.exif"] : []));
  assert.deepEqual(bad, ["audio.wav: assertion stds.exif"]);
});
