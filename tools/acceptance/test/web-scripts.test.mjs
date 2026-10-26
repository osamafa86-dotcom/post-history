import test from "node:test";
import assert from "node:assert/strict";
import { validateMeasurement } from "../lib/measurement.mjs";
import { ffmpegArgs, finishAndWrite, envDoc, result, EnvironmentError, exitCodeFor, SIZE_TOLERANCE } from "../scripts/web-gap-helpers.mjs";
import { assessResume, RESEND_BUDGET } from "../scripts/web-upload-resume.mjs";
import { markerDiffers } from "../scripts/web-sensitivity-catalog.mjs";
import { judgeLayout } from "../scripts/web-mobile-390.mjs";
import { classify, reportText } from "../scripts/web-a11y.mjs";
import { run as e2e } from "../scripts/web-e2e.mjs";
import { run as resume } from "../scripts/web-upload-resume.mjs";
import { run as sensitivity } from "../scripts/web-sensitivity-catalog.mjs";
import { run as mobile } from "../scripts/web-mobile-390.mjs";
import { run as a11y } from "../scripts/web-a11y.mjs";
import { byName } from "../lib/catalog.mjs";

test("the browser scripts' result documents pass measurement.json (upload_path is in the schema's list)", () => {
  for (const [name, upload] of [["web-upload-resume", "tusd"], ["web-sensitivity-catalog", "tusd"], ["web-mobile-390", undefined], ["web-a11y", undefined], ["receipt-notification", "tusd"]]) {
    const doc = envDoc({}, name, upload ? { upload_path: upload } : {});
    const out = finishAndWrite(doc, ["--dry-run"], "browser", "partial", { checks: 1 }, "x");
    assert.equal(out.error, null, `${name}: ${out.error?.message}`);
    assert.deepEqual(validateMeasurement(doc).errors, []);
  }
  assert.equal(result("x", {}).upload_path, "n/a");
});

test("a result the schema rejects is reported, not thrown, so a catch path cannot throw twice", () => {
  const doc = envDoc({}, "web-a11y", { upload_path: "web" });
  const out = finishAndWrite(doc, ["--dry-run"], "browser", "partial", {}, "x");
  assert.ok(out.error);
  assert.equal(out.file, null);
});

test("the synthetic clip command puts the bitrate options after the pixel format value, not inside it", () => {
  const args = ffmpegArgs("out.mp4", { seconds: 200, megabytes: 200 });
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
  const rate = args[args.indexOf("-b:v") + 1];
  assert.match(rate, /^\d+k$/);
  // 200 MiB over 200 s is about 8.4 Mbit/s
  assert.ok(Math.abs(parseInt(rate, 10) - 8389) < 5, rate);
  assert.ok(args.some((a) => /noise=/.test(a)), "high-entropy source, so the size follows the bitrate rather than zero padding");
  assert.equal(args.at(-1), "out.mp4");
  assert.ok(SIZE_TOLERANCE > 0.5 && SIZE_TOLERANCE < 1);
  assert.equal(ffmpegArgs("o.mp4", { seconds: 10 }).includes("-b:v"), false);
});

test("resume: a restart from zero, a large re-send, a backwards offset and no PATCH at all are each findings", () => {
  const size = 1000;
  assert.deepEqual(assessResume({ before: 400, after: [380, 500, 600], size }), []);
  assert.ok(assessResume({ before: 400, after: [0, 200], size }).some((p) => /zero/.test(p)), "zero is kept in the list");
  assert.ok(assessResume({ before: 400, after: [400 - size * RESEND_BUDGET - 1], size }).some((p) => /re-sent/.test(p)));
  assert.ok(assessResume({ before: 400, after: [400, 300], size }).some((p) => /backwards/.test(p)));
  assert.ok(assessResume({ before: 400, after: [], size }).some((p) => /no PATCH/.test(p)));
  assert.ok(assessResume({ before: 0, after: [10], size }).some((p) => /never reached/.test(p)));
});

test("sensitivity: the mark counts only when it is on the sensitive details and missing from the unmarked control's", () => {
  assert.equal(markerDiffers("تفاصيل المادة · مشاهد حساسة", "تفاصيل المادة"), true);
  assert.equal(markerDiffers("page about sensitive things", "page about sensitive things"), false, "a word on both pages proves nothing");
  assert.equal(markerDiffers("no mark", "no mark"), false);
});

test("mobile layout: each failure mode is named, a clean page has none", () => {
  assert.deepEqual(judgeLayout({ horizontal: false, outside: 0, cropped: 0 }), []);
  assert.deepEqual(judgeLayout({ horizontal: true, outside: 2, cropped: 1 }).length, 3);
});

test("axe: serious and critical block, minor and moderate are recorded only", () => {
  const v = (id, impact) => ({ id, impact, help: "h", nodes: [{ target: ["#a", ".b"] }] });
  const found = classify([v("color-contrast", "serious"), v("region", "moderate"), v("image-alt", "critical"), v("x", undefined)]);
  assert.equal(found.rows.length, 4);
  assert.deepEqual(found.blocking.map((r) => r.id), ["color-contrast", "image-alt"]);
  assert.match(reportText(found.rows.map((r) => ({ ...r, page: "/ar/inbox" })), "t"), /\| \/ar\/inbox \| color-contrast \| #a \.b \| h \| serious \|/);
  assert.match(reportText([], "t"), /لا مخالفات Axe/);
});

test("without its environment each browser script measures nothing and exits 2", async () => {
  for (const run of [e2e, resume, sensitivity, mobile, a11y]) {
    const out = await run(["--dry-run"], {});
    assert.deepEqual(out, { code: 2, doc: null });
  }
});

test("an environment problem is exit 2, a measured failure is exit 1", () => {
  assert.equal(exitCodeFor(new EnvironmentError("no browser")), 2);
  assert.equal(exitCodeFor(new Error("x")), 1);
});

test("every browser script is a named test of the catalog, so its results pass the results gate", () => {
  for (const n of ["web-upload-resume", "web-sensitivity-catalog", "web-mobile-390", "web-a11y", "receipt-notification"]) assert.ok(byName(n), n);
});
