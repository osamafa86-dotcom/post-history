#!/usr/bin/env node
// فحص وصول وRTL بلا لقطات: Axe على الصفحات الرئيسية بالعربية والإنجليزية بعد اكتمال محتواها. Axe آلي ويغطي جزءًا من
// المعيار (لا لوحة مفاتيح ولا قارئ شاشة ولا تخطيط RTL إلا سمة dir)، فالنتيجة `partial` دائمًا ما لم تُفشلها المخالفات.
// @axe-core/playwright يُحمّل ديناميكيًا؛ لا تُضاف تبعية إلى حزمة القبول.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { banner } from "../lib/measurement.mjs";
import { scrub, envMissing, url, loadPlaywright, login, envDoc, checkList, finishAndWrite, exitCodeFor, EnvironmentError } from "./web-gap-helpers.mjs";

export const BLOCKING = new Set(["serious", "critical"]);

/** يصنّف مخالفات Axe: التي تُفشل (serious وcritical) والتي تُسجَّل فقط. */
export function classify(violations) {
  const rows = violations.flatMap((v) => v.nodes.map((n) => ({ id: v.id, target: n.target.join(" "), help: v.help, impact: v.impact ?? "unknown" })));
  return { rows, blocking: rows.filter((r) => BLOCKING.has(r.impact)) };
}

async function loadAxe() {
  const candidates = [process.env.AXE_PLAYWRIGHT_MODULE, "@axe-core/playwright"].filter(Boolean);
  let last;
  for (const spec of candidates) {
    try { return await import(spec); } catch (e) { last = e; }
  }
  throw new EnvironmentError(`@axe-core/playwright is unavailable: ${last?.message ?? "install it outside this repository"}`);
}

export function reportText(rows, started) {
  const lines = ["# تقرير الوصول وRTL", "", `وقت التشغيل: ${started}`, "", "لا تُحفظ لقطات. المسارات فقط؛ لا يتضمن التقرير نطاقًا أو حسابات أو رموز وصول.", "", "## النتائج", "", "| الصفحة | القاعدة | العنصر | الاقتراح | الشدة |", "| --- | --- | --- | --- | --- |"];
  if (!rows.length) lines.push("| — | لا مخالفات Axe | — | — | — |");
  for (const row of rows) lines.push(`| ${row.page} | ${row.id} | ${row.target} | ${row.help} | ${row.impact} |`);
  return `${lines.join("\n")}\n`;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-a11y", criterion: "Axe (wcag2a وwcag2aa) على الصفحات الرئيسية بالعربية والإنجليزية بعد اكتمال المحتوى؛ فشل عند مخالفات serious أو critical، وسمة dir صحيحة" });
  const absent = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_SUPERVISOR_EMAIL", "ACCEPTANCE_SUPERVISOR_PASSWORD"]);
  if (absent.length) { console.error(`ENVIRONMENT: missing ${absent.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-a11y", { device: { platform: "browser", model: "Playwright + axe" } });
  const started = new Date().toISOString();
  const rows = [], { checks, check } = checkList();
  const timeout = Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000);
  let browser;
  const scan = async (page, path, locale, AxeBuilder) => {
    await page.goto(url(env, path), { waitUntil: "domcontentloaded" });
    // Axe على هيكل بلا بيانات يمر فارغًا: ينتظر شبكة هادئة ومحتوى نصيًا في المحتوى الرئيسي
    await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
    const chars = (await page.getByRole("main").innerText().catch(() => "")).trim().length;
    check(`${path} has rendered content`, chars > 0, `main text chars=${chars}`);
    const direction = await page.locator("html").getAttribute("dir");
    check(`${path} direction`, direction === (locale === "ar" ? "rtl" : "ltr"), `dir=${direction}`);
    const found = classify((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations);
    rows.push(...found.rows.map((r) => ({ ...r, page: path })));
    check(`${path} Axe serious/critical`, found.blocking.length === 0, found.blocking.map((r) => `${r.id}:${r.impact}`).join(", "));
  };
  try {
    const { chromium } = await loadPlaywright();
    const { AxeBuilder } = await loadAxe();
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    for (const locale of ["ar", "en"]) {
      const reporter = await browser.newContext(), page = await reporter.newPage();
      await login(page, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD, locale });
      for (const path of [`/${locale}/inbox`, `/${locale}/upload`, `/${locale}/notifications`]) await scan(page, path, locale, AxeBuilder);
      await reporter.close();
      const supervisor = await browser.newContext(), board = await supervisor.newPage();
      await login(board, env, { email: env.ACCEPTANCE_SUPERVISOR_EMAIL, password: env.ACCEPTANCE_SUPERVISOR_PASSWORD, locale });
      await scan(board, `/${locale}/board`, locale, AxeBuilder);
      await supervisor.close();
    }
    // التقرير لا يُكتب فوق ملف متتبَّع: مجلد مؤقت ما لم يُعيَّن A11Y_REPORT_PATH
    const report = env.A11Y_REPORT_PATH ?? join(tmpdir(), "post-history-a11y", "a11y-report.md");
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, scrub(reportText(rows, started)));
    const failures = checks.filter((x) => !x.ok);
    const out = finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "partial", {
      pages: checks.filter((x) => /Axe/.test(x.name)).length, checks: checks.length, checks_failed: failures.length, axe_violations: rows.length,
      serious_critical: rows.filter((r) => BLOCKING.has(r.impact)).length, rtl_ltr_checked: checks.filter((x) => /direction/.test(x.name)).length,
      keyboard_checked: false, screen_reader_checked: false,
    }, failures.length ? failures.map((x) => `${x.name}: ${x.detail}`).join("؛ ") : "Axe آلي (wcag2a وwcag2aa) بعد اكتمال المحتوى، وسمة dir؛ لا لوحة مفاتيح ولا قارئ شاشة ولا تخطيط RTL، فالنتيجة جزئية؛ التقرير النصي خارج المستودع ما لم يُعيَّن A11Y_REPORT_PATH");
    return { code: failures.length || out.error ? 1 : 0, doc };
  } catch (error) {
    if (error instanceof EnvironmentError) { console.error(`ENVIRONMENT: ${scrub(error.message)}; nothing measured`); return { code: 2, doc: null }; }
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${scrub(error.message)}`);
    return { code: exitCodeFor(error), doc };
  } finally { await browser?.close(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
