import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planAcceptanceRows, analysisPackages, matchCatalog, nameFromFilename,
  loadMeasurements, latestMeasurement, buildReport, formatReport, run,
} from "./gap-report.mjs";

// حقول صغيرة ثابتة: ثلاثة صفوف خطة ومدخلة إضافية واحدة وقياسات تغطي الناجح والجزئي والأقدم فالأحدث.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gap-report-"));
  mkdirSync(join(dir, "meas/sub"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "live"));
  mkdirSync(join(dir, "field"));

  const plan = `## اختبارات القبول

| الاختبار | معيار القبول |
| --- | --- |
| استئناف الرفع | يستأنف من آخر ما وصل وتطابق البصمة |
| الحمل المتزامن | ستون رفعًا دون تدهور |
| الاسترداد | قيد عكسي صحيح |

## قسم آخر
`;
  writeFileSync(join(dir, "plan.md"), plan);

  const catalog = `export const CATALOG = [
  { name: "upload-resume", mode: "automated", criterion: "يستأنف من آخر ما وصل وتطابق البصمة" },
  { name: "concurrent-load", mode: "automated", criterion: "ستون رفعًا دون تدهور" },
  { name: "refund", mode: "pending", criterion: "قيد عكسي صحيح" },
];
export const EXTRA = [
  { name: "admin-quorum", mode: "automated", criterion: "ثنائي الأشخاص" },
];
`;
  writeFileSync(join(dir, "catalog.mjs"), catalog);

  const analysis = `| استئناف الرفع | \`scripts/upload-resume.mjs\` | موجود | \`apps/api\` | شيء |
| نصاب المدراء | \`scripts/admin-quorum.mjs\` | **غائب** | \`apps/api\` | شيء |
`;
  writeFileSync(join(dir, "analysis.md"), analysis);

  const meas = (over) => JSON.stringify({
    schema_version: 1, tool: "acceptance", role: "qa",
    started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:01:00Z",
    result: "pass", metrics: {}, ...over,
  });
  // قياسان للاختبار نفسه: الأحدث جزئي ويجب أن يُختار.
  writeFileSync(join(dir, "meas/2026-10-19-upload-resume-a.json"), meas({ test_name: "upload-resume", ended_at: "2026-10-19T10:01:00Z" }));
  writeFileSync(join(dir, "meas/sub/2026-10-20-upload-resume-b.json"), meas({ test_name: "upload-resume", result: "partial", notes: "الحجم أصغر من المعيار" }));
  // بلا test_name: يُربط باسم السكربت من اسم الملف.
  writeFileSync(join(dir, "meas/2026-10-21-admin-quorum-api.json"), meas({ test_name: undefined, result: "pass" }));
  // يتيم (لا يطابق الكتالوج) وآخر تالف.
  writeFileSync(join(dir, "meas/2026-10-19-other-tool.json"), meas({ test_name: "other-tool" }));
  writeFileSync(join(dir, "meas/broken.json"), "{ nope");

  writeFileSync(join(dir, "scripts/upload-resume.mjs"), "// stub\n");
  writeFileSync(join(dir, "scripts/concurrent-load.mjs"), "// stub\n");
  writeFileSync(join(dir, "scripts/refund.mjs"), "// stub\n");
  writeFileSync(join(dir, "live/admin-quorum.mjs"), "// stub\n");

  return {
    dir,
    env: {
      GAP_REPORT_PLAN: join(dir, "plan.md"),
      GAP_REPORT_CATALOG: join(dir, "catalog.mjs"),
      GAP_REPORT_MEASUREMENTS: join(dir, "meas"),
      GAP_REPORT_ANALYSIS: join(dir, "analysis.md"),
      GAP_REPORT_OUT: join(dir, "out.md"),
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("يقرأ صفوف جدول اختبارات القبول وحده", () => {
  const rows = planAcceptanceRows("## اختبارات القبول\n\n| الاختبار | معيار القبول |\n| --- | --- |\n| أ | معيار أ |\n| ب | معيار ب |\n\n## تالٍ\n| ج | معيار ج |\n");
  assert.deepEqual(rows, [{ name: "أ", criterion: "معيار أ" }, { name: "ب", criterion: "معيار ب" }]);
  assert.throws(() => planAcceptanceRows("## غيره\n"), /اختبارات القبول/);
});

test("يربط صفوف الخطة بالكتالوج بالمعيار ويتحمل تحريرًا طفيفًا", () => {
  const rows = [{ name: "أ", criterion: "يستأنف من آخر ما وصل وتطابق البصمة الكاملة" }];
  const catalog = [{ name: "upload-resume", mode: "automated", criterion: "يستأنف من آخر ما وصل وتطابق البصمة" }];
  const matched = matchCatalog(rows, catalog);
  assert.equal(matched[0].entry.name, "upload-resume");
  assert.throws(() => matchCatalog([{ name: "س", criterion: "مختلف تماما عن كل شيء" }], catalog), /لا مدخلة/);
});

test("يستخرج اسم الاختبار من اسم الملف بأطول تطابق", () => {
  const names = new Set(["admin-quorum", "admin", "pii-leak"]);
  assert.equal(nameFromFilename("2026-10-26-admin-quorum-api.json", names), "admin-quorum");
  assert.equal(nameFromFilename("2026-10-19-pii-leak.json", names), "pii-leak");
  assert.equal(nameFromFilename("2026-10-19-unknown-thing.json", names), null);
});

test("يفهرس القياسات ويختار الأحدث ويحسب اليتامى والتالفة", () => {
  const { dir, cleanup } = fixture();
  try {
    const names = new Set(["upload-resume", "concurrent-load", "refund", "admin-quorum"]);
    const { byTest, orphans, invalid } = loadMeasurements(join(dir, "meas"), names);
    assert.equal(orphans, 1);
    assert.equal(invalid, 1);
    assert.equal(byTest.get("upload-resume").length, 2);
    const latest = latestMeasurement(byTest.get("upload-resume"));
    assert.equal(latest.result, "partial");
    assert.equal(latest.notes, "الحجم أصغر من المعيار");
    // بلا test_name لُقياس admin-quorum عبر اسم الملف.
    assert.equal(byTest.get("admin-quorum")[0].result, "pass");
  } finally {
    cleanup();
  }
});

test("يبني الصفوف: لا قياس، ينتظر حزمته، والحزمة من التحليل التاريخي", async () => {
  const { dir, cleanup } = fixture();
  try {
    const names = new Set(["upload-resume", "concurrent-load", "refund", "admin-quorum"]);
    const measurements = loadMeasurements(join(dir, "meas"), names);
    const packages = analysisPackages(readFileSync(join(dir, "analysis.md"), "utf8"));
    const catalog = (await import(join(dir, "catalog.mjs")));
    const dirs = { scripts: join(dir, "scripts"), live: join(dir, "live"), field: join(dir, "field") };
    const planRows = planAcceptanceRows(readFileSync(join(dir, "plan.md"), "utf8"));
    const { planTable, extraTable } = buildReport({
      planRows, catalog: catalog.CATALOG, extra: catalog.EXTRA, measurements, packages, dirs,
    });
    const [resume, load, refund] = planTable;
    assert.equal(resume.package, "apps/api");
    assert.match(resume.measurement, /2026-10-20 — جزئي؛ ما لم يتحقق: الحجم أصغر/);
    assert.equal(resume.gap, "القياس الأخير جزئي");
    assert.equal(load.measurement, "لا يوجد");
    assert.equal(load.gap, "لا قياس بعد");
    assert.equal(refund.gap, "الحزمة لم تُبنَ بعد؛ لا قياس بعد");
    assert.equal(extraTable[0].script, "tools/acceptance/live/admin-quorum.mjs");
    assert.equal(extraTable[0].gap, "مغلق بحسب آخر قياس");
    const report = formatReport({ planTable, extraTable, orphans: measurements.orphans, invalid: measurements.invalid });
    assert.match(report, /ملف مولَّد آليًا/);
    assert.match(report, /## اختبارات القبول \(جدول الخطة\)/);
    assert.match(report, /## الخلاصة/);
  } finally {
    cleanup();
  }
});

test("run: يكتب الملف، و--check ينجح بعده ويفشل إن تغيّر المخزن، و--json يطبع الصفوف", async () => {
  const { dir, env, cleanup } = fixture();
  try {
    const first = await run([], env);
    assert.equal(first.code, 0);
    const stored = readFileSync(env.GAP_REPORT_OUT, "utf8");
    assert.equal(stored, first.report);

    const ok = await run(["--check"], env);
    assert.equal(ok.code, 0);

    writeFileSync(env.GAP_REPORT_OUT, "قديم");
    const stale = await run(["--check"], env);
    assert.equal(stale.code, 1);

    const asJson = await run(["--json"], env);
    assert.equal(asJson.code, 0);
    // كُتب الملف مجددًا لأن --json بلا --check يكتب.
    assert.equal(readFileSync(env.GAP_REPORT_OUT, "utf8"), asJson.report);
  } finally {
    cleanup();
  }
});

test("run: خروج 2 عند غياب المدخلات", async () => {
  const bad = await run([], {
    GAP_REPORT_PLAN: "/nonexistent/plan.md",
    GAP_REPORT_CATALOG: "/nonexistent/catalog.mjs",
    GAP_REPORT_MEASUREMENTS: "/nonexistent",
    GAP_REPORT_ANALYSIS: "/nonexistent/a.md",
    GAP_REPORT_OUT: "/nonexistent/out.md",
  });
  assert.equal(bad.code, 2);
});
