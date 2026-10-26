#!/usr/bin/env node
// مولّد تقرير الفجوات: يقابل اختبارات القبول في الخطة بسكربتات tools/acceptance وبآخر قياس موثق،
// ويكتب docs/plan/gap-report.md. لا يعدّل gap-analysis-2026-10.md (وثيقة تاريخية) بل يقرأ منها عمود الحزمة فقط.
// الربط قياس ← اختبار: حقل test_name أولًا، ثم اسم السكربت من اسم الملف (<التاريخ>-<الاسم>-<وصف>.json) عند غيابه.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RESULTS = new Set(["pass", "fail", "partial", "info"]);

/** صفوف جدول «اختبارات القبول» في الخطة: الاسم العربي ومعيار القبول، بترتيب الورود. */
export function planAcceptanceRows(markdown) {
  const start = markdown.search(/^## اختبارات القبول\s*$/m);
  if (start === -1) throw new Error("قسم «اختبارات القبول» غير موجود في ملف الخطة");
  const rest = markdown.slice(start);
  const next = rest.indexOf("\n## ", 10);
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\| (.+?) \| (.+?) \|\s*$/);
    if (!m) continue;
    const [name, criterion] = [m[1].trim(), m[2].trim()];
    if (name === "الاختبار" || /^-+$/.test(name)) continue;
    rows.push({ name, criterion });
  }
  if (!rows.length) throw new Error("جدول «اختبارات القبول» بلا صفوف");
  return rows;
}

/** عمود «الحزمة المالكة» من تحليل الفجوات التاريخي، مفهرسًا باسم السكربت. */
export function analysisPackages(markdown) {
  const packages = new Map();
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\| (.+?) \| `scripts\/([a-z0-9-]+)\.mjs` \| .+? \| (.+?) \| .+? \|\s*$/);
    if (m) packages.set(m[2], m[3].trim().replace(/^`+|`+$/g, ""));
  }
  return packages;
}

/** طول البادئة المشتركة نسبةً إلى أقصر نص؛ 1.0 عندما يسبق أحد النصين الآخر تمامًا. */
function prefixScore(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i / Math.max(1, n);
}

/**
 * يربط صف الخطة بمدخلة الكتالوج بأعلى تطابق في نص المعيار (عتبة 0.6 تتحمل تحريرًا طفيفًا لأحد المصدرين).
 * يرمي خطأ عند التعذر: صف بلا سكربت معلومة يجب أن تُراجع لا أن تُخمَّن.
 */
export function matchCatalog(planRows, catalog) {
  const used = new Set();
  return planRows.map((row) => {
    let best = -1;
    let bestScore = 0;
    catalog.forEach((entry, i) => {
      if (used.has(i)) return;
      const score = prefixScore(row.criterion, entry.criterion);
      if (score > bestScore) { best = i; bestScore = score; }
    });
    if (best === -1 || bestScore < 0.6) {
      throw new Error(`لا مدخلة كتالوج تطابق صف الخطة «${row.name}» (أفضل تطابق ${bestScore.toFixed(2)})`);
    }
    used.add(best);
    return { ...row, entry: catalog[best], score: bestScore };
  });
}

/** اسم الاختبار من اسم ملف القياس: يُسقِط التاريخ ثم يأخذ أطول اسم كتالوج يسبق الباقي عند حد «-». */
export function nameFromFilename(file, names) {
  const base = file.replace(/\.json$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  let found = null;
  for (const name of names) {
    if (base === name || base.startsWith(`${name}-`)) {
      if (!found || name.length > found.length) found = name;
    }
  }
  return found;
}

function walkJson(dir) {
  const out = [];
  for (const item of readdirSync(dir)) {
    const path = join(dir, item);
    if (statSync(path).isDirectory()) out.push(...walkJson(path));
    else if (item.endsWith(".json")) out.push(path);
  }
  return out;
}

/**
 * يقرأ كل ملفات JSON تحت docs/measurements ويفهرسها باسم الاختبار.
 * الملف بلا test_name يُربط باسم السكربت من اسم الملف؛ ما لا يطابق كتالوج القبول يُحسب «يتيمًا» (قياسات أدوات أخرى).
 */
export function loadMeasurements(dir, names) {
  const byTest = new Map();
  let orphans = 0;
  let invalid = 0;
  for (const path of walkJson(dir)) {
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      invalid += 1;
      continue;
    }
    if (!data || !RESULTS.has(data.result)) { invalid += 1; continue; }
    const testName = typeof data.test_name === "string" && data.test_name
      ? data.test_name
      : nameFromFilename(path.split("/").pop(), names);
    if (!testName || !names.has(testName)) { orphans += 1; continue; }
    const at = data.ended_at ?? data.started_at ?? "";
    const list = byTest.get(testName) ?? [];
    list.push({ testName, result: data.result, at, notes: data.notes ?? "", file: path });
    byTest.set(testName, list);
  }
  return { byTest, orphans, invalid };
}

/** الأحدث بتاريخ الانتهاء، وعند التعادل باسم الملف ليكون الاختيار حتميًا. */
export function latestMeasurement(list) {
  return [...list].sort((a, b) => a.at.localeCompare(b.at) || a.file.localeCompare(b.file)).at(-1) ?? null;
}

/** مسار السكربت المعروض: الآلي في scripts/ ثم الحي في live/، وإلا ورقة الخطوات الميدانية في field/. */
function scriptCell(name, dirs) {
  if (existsSync(join(dirs.scripts, `${name}.mjs`))) return `tools/acceptance/scripts/${name}.mjs`;
  if (existsSync(join(dirs.live, `${name}.mjs`))) return `tools/acceptance/live/${name}.mjs`;
  if (existsSync(join(dirs.field, `${name}.md`))) return `tools/acceptance/field/${name}.md`;
  return null;
}

function short(text, limit = 140) {
  const clean = String(text).replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

const RESULT_AR = { pass: "ناجح", partial: "جزئي", fail: "فاشل", info: "معلومة" };

/** يبني صف تقرير واحدًا من مدخلة كتالوج وقياساتها وحزمتها. */
function buildRow({ arabicName, entry, measurements, packages, dirs }) {
  const script = scriptCell(entry.name, dirs);
  const latest = latestMeasurement(measurements.byTest.get(entry.name) ?? []);
  const pkg = packages.get(entry.name) ?? "—";
  const gaps = [];
  if (!script) gaps.push("لا سكربت");
  if (entry.mode === "pending") gaps.push("الحزمة لم تُبنَ بعد");
  if (!latest) {
    if (script) gaps.push("لا قياس بعد");
  } else if (latest.result === "fail") {
    gaps.push("القياس الأخير فشل");
  } else if (latest.result === "partial") {
    gaps.push("القياس الأخير جزئي");
  } else if (latest.result === "info") {
    gaps.push("القياس الأخير معلومة لا حكم");
  }
  const gap = gaps.length ? gaps.join("؛ ") : (entry.mode === "field" ? "آخر قياس ناجح (ميداني يُعاد دوريًا)" : "مغلق بحسب آخر قياس");
  let measurement = "لا يوجد";
  if (latest) {
    measurement = `${latest.at.slice(0, 10)} — ${RESULT_AR[latest.result]}`;
    if ((latest.result === "partial" || latest.result === "fail") && latest.notes) {
      measurement += `؛ ما لم يتحقق: ${short(latest.notes)}`;
    }
  }
  return {
    test: arabicName ?? entry.name,
    script: script ?? "لا سكربت",
    measurement,
    package: pkg,
    gap,
    closed: !gaps.length,
    latestFile: latest ? latest.file : null,
  };
}

export function buildReport({ planRows, catalog, extra, measurements, packages, dirs }) {
  const matched = matchCatalog(planRows, catalog);
  const planTable = matched.map((row) => buildRow({
    arabicName: row.name, entry: row.entry, measurements, packages, dirs,
  }));
  const extraTable = extra.map((entry) => buildRow({
    arabicName: null, entry, measurements, packages, dirs,
  }));
  return { planTable, extraTable };
}

function summarize(rows) {
  const count = (pred) => rows.filter(pred).length;
  const parts = [
    `${rows.length} اختبارًا`,
    `${count((r) => r.closed)} مغلقًا بحسب آخر قياس`,
    `${count((r) => r.gap.includes("جزئي"))} بقياس جزئي`,
    `${count((r) => r.gap.includes("فشل"))} بقياس فاشل`,
    `${count((r) => r.gap.includes("لا قياس"))} بلا قياس`,
    `${count((r) => r.gap.includes("لم تُبنَ"))} ينتظر حزمته`,
  ];
  return parts.join("، ");
}

function tableMarkdown(rows) {
  const lines = ["| اختبار القبول | السكربت | آخر قياس | الحزمة | الفجوة |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows) {
    lines.push(`| ${row.test} | \`${row.script}\` | ${row.measurement} | ${row.package} | ${row.gap} |`);
  }
  return lines.join("\n");
}

export function formatReport({ planTable, extraTable, orphans, invalid }) {
  return [
    "# تقرير الفجوات بين الخطة والقياسات",
    "",
    "> ملف مولَّد آليًا بـ `node tools/gap-report.mjs`؛ لا يُحرَّر يدويًا وأي تحرير يضيع عند أول توليد.",
    "> المصادر: قسم «اختبارات القبول» في `docs/plan/الخطة-النسخة-الثالثة.md`، وكتالوج `tools/acceptance/lib/catalog.mjs`،",
    "> وملفات `docs/measurements/**/*.json` (الربط بـ `test_name` ثم باسم السكربت من اسم الملف)، وعمود الحزمة من",
    "> `docs/plan/gap-analysis-2026-10.md` — وثيقة تاريخية تُقرأ ولا تُعدَّل.",
    "",
    "## اختبارات القبول (جدول الخطة)",
    "",
    tableMarkdown(planTable),
    "",
    "## اختبارات إضافية من قرارات الأمن والكتالوج",
    "",
    "ليست صفوفًا في جدول الخطة؛ مصدر كل منها مذكور في الكتالوج.",
    "",
    tableMarkdown(extraTable),
    "",
    "## الخلاصة",
    "",
    `- جدول الخطة: ${summarize(planTable)}.`,
    `- الإضافية: ${summarize(extraTable)}.`,
    `- قياسات لا ترتبط باختبار قبول في الكتالوج: ${orphans} (نتائج أدوات أخرى كـ netlab وasr-bench، وليست فجوات).`,
    invalid ? `- ملفات قياس غير صالحة أُهملت: ${invalid}.` : null,
    "",
  ].filter((l) => l !== null).join("\n");
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const toolsDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(toolsDir, "..");
  const planFile = resolve(env.GAP_REPORT_PLAN ?? join(root, "docs/plan/الخطة-النسخة-الثالثة.md"));
  const catalogFile = resolve(env.GAP_REPORT_CATALOG ?? join(root, "tools/acceptance/lib/catalog.mjs"));
  const measurementsDir = resolve(env.GAP_REPORT_MEASUREMENTS ?? join(root, "docs/measurements"));
  const analysisFile = resolve(env.GAP_REPORT_ANALYSIS ?? join(root, "docs/plan/gap-analysis-2026-10.md"));
  const outFile = resolve(env.GAP_REPORT_OUT ?? join(root, "docs/plan/gap-report.md"));

  let inputs;
  try {
    const catalogModule = await import(pathToFileURL(catalogFile).href);
    const catalog = catalogModule.CATALOG ?? [];
    const extra = catalogModule.EXTRA ?? [];
    const names = new Set([...catalog, ...extra].map((t) => t.name));
    inputs = {
      planRows: planAcceptanceRows(readFileSync(planFile, "utf8")),
      catalog,
      extra,
      measurements: loadMeasurements(measurementsDir, names),
      packages: analysisPackages(readFileSync(analysisFile, "utf8")),
      dirs: {
        scripts: join(root, "tools/acceptance/scripts"),
        live: join(root, "tools/acceptance/live"),
        field: join(root, "tools/acceptance/field"),
      },
    };
  } catch (error) {
    console.error(`تعذر توليد التقرير: ${error.message}`);
    return { code: 2 };
  }

  const { planTable, extraTable } = buildReport(inputs);
  const report = formatReport({
    planTable, extraTable, orphans: inputs.measurements.orphans, invalid: inputs.measurements.invalid,
  });

  if (argv.includes("--json")) {
    const rel = (f) => (f ? relative(root, f) : null);
    console.log(JSON.stringify({
      plan: planTable.map((r) => ({ ...r, latestFile: rel(r.latestFile) })),
      extra: extraTable.map((r) => ({ ...r, latestFile: rel(r.latestFile) })),
      orphans: inputs.measurements.orphans,
      invalid: inputs.measurements.invalid,
    }, null, 1));
  } else {
    console.log(report);
  }

  if (argv.includes("--check")) {
    const stored = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    if (stored !== report) {
      console.error(`الملف المخزن ${relative(root, outFile)} لا يطابق المولَّد؛ شغّل: node tools/gap-report.mjs`);
      return { code: 1, report };
    }
    return { code: 0, report };
  }

  writeFileSync(outFile, report);
  console.error(`كُتب ${relative(root, outFile)}`);
  return { code: 0, report };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { code } = await run();
  process.exitCode = code;
}
