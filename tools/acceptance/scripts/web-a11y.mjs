#!/usr/bin/env node
// فحص وصول وRTL بلا لقطات: Axe على الصفحات الرئيسية بالعربية والإنجليزية.
// @axe-core/playwright يُحمّل ديناميكيًا؛ لا تُضاف تبعية إلى حزمة القبول.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { banner, newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";

async function loadAxe() {
  const candidates = [process.env.AXE_PLAYWRIGHT_MODULE, "@axe-core/playwright"].filter(Boolean);
  let last;
  for (const spec of candidates) {
    try { return await import(spec); } catch (e) { last = e; }
  }
  throw new Error(`@axe-core/playwright is unavailable: ${last?.message ?? "install it outside this repository"}`);
}
function missing(env) { return ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_SUPERVISOR_EMAIL", "ACCEPTANCE_SUPERVISOR_PASSWORD"].filter((key) => !env[key]); }
function pathUrl(base, path) { return new URL(path, `${base.replace(/\/$/, "")}/`).toString(); }
async function login(page, env, locale, account) {
  await page.goto(pathUrl(env.ACCEPTANCE_BASE_URL, `/${locale}/login`), { waitUntil: "domcontentloaded" });
  await page.getByLabel(/البريد الإلكتروني|Email/i).fill(account.email);
  await page.getByLabel(/كلمة المرور|Password/i).fill(account.password);
  const totp = page.getByLabel(/رمز التحقق|TOTP|one-time/i).first(); if (await totp.count()) await totp.fill(env.ACCEPTANCE_TOTP ?? "");
  await page.getByRole("button", { name: /دخول|Sign in|Login/i }).click();
  await page.waitForURL(/\/((ar|en)\/)?inbox(?:\?|$)/, { timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
}
function pages(locale) { return [`/${locale}/inbox`, `/${locale}/upload`, `/${locale}/notifications`, `/${locale}/board`]; }
function reportText(rows, started) {
  const lines = ["# تقرير الوصول وRTL — 2026-10", "", `وقت التشغيل: ${started}`, "", "لا تُحفظ لقطات. المسارات فقط؛ لا يتضمن التقرير نطاقًا أو حسابات أو رموز وصول.", "", "## النتائج", "", "| الصفحة | القاعدة | العنصر | الاقتراح | الشدة |", "| --- | --- | --- | --- | --- |"];
  if (!rows.length) lines.push("| — | لا مخالفات Axe | — | — | — |");
  for (const row of rows) lines.push(`| ${row.page} | ${row.id} | ${row.target} | ${row.help} | ${row.impact ?? "غير محددة"} |`);
  return `${lines.join("\n")}\n`;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-a11y", criterion: "Axe على الصفحات الرئيسية بالعربية والإنجليزية؛ فشل عند مخالفات serious أو critical مع تحقق RTL/LTR" });
  const absent = missing(env);
  if (absent.length) { console.error(`ENVIRONMENT: missing ${absent.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = newResult("web-a11y", { device: { platform: "browser", model: "Playwright + axe" }, upload_path: "web" });
  const started = new Date().toISOString(); const rows = []; const checks = []; let browser;
  const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  try {
    const { chromium } = await (async () => { for (const spec of [process.env.PLAYWRIGHT_MODULE, "@playwright/test", "../../../apps/web/node_modules/@playwright/test/index.mjs"].filter(Boolean)) { try { return await import(spec); } catch {} } throw new Error("Playwright is unavailable"); })();
    const { AxeBuilder } = await loadAxe(); browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    for (const locale of ["ar", "en"]) {
      const reporter = await browser.newContext(); const page = await reporter.newPage();
      await login(page, env, locale, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD });
      for (const path of pages(locale).filter((p) => !p.endsWith("/board"))) {
        await page.goto(pathUrl(env.ACCEPTANCE_BASE_URL, path), { waitUntil: "domcontentloaded" });
        const direction = await page.locator("html").getAttribute("dir"); check(`${path} direction`, direction === (locale === "ar" ? "rtl" : "ltr"), `dir=${direction}`);
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        for (const violation of result.violations) for (const node of violation.nodes) rows.push({ page: path, id: violation.id, target: node.target.join(" "), help: violation.help, impact: violation.impact });
        check(`${path} Axe serious/critical`, !result.violations.some((v) => ["serious", "critical"].includes(v.impact)), result.violations.map((v) => `${v.id}:${v.impact}`).join(", "));
      }
      await reporter.close();
      const supervisor = await browser.newContext(); const board = await supervisor.newPage();
      await login(board, env, locale, { email: env.ACCEPTANCE_SUPERVISOR_EMAIL, password: env.ACCEPTANCE_SUPERVISOR_PASSWORD });
      const path = `/${locale}/board`; await board.goto(pathUrl(env.ACCEPTANCE_BASE_URL, path), { waitUntil: "domcontentloaded" });
      const direction = await board.locator("html").getAttribute("dir"); check(`${path} direction`, direction === (locale === "ar" ? "rtl" : "ltr"), `dir=${direction}`);
      const result = await new AxeBuilder({ page: board }).withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const violation of result.violations) for (const node of violation.nodes) rows.push({ page: path, id: violation.id, target: node.target.join(" "), help: violation.help, impact: violation.impact });
      check(`${path} Axe serious/critical`, !result.violations.some((v) => ["serious", "critical"].includes(v.impact)), result.violations.map((v) => `${v.id}:${v.impact}`).join(", "));
      await supervisor.close();
    }
    const report = env.A11Y_REPORT_PATH ?? join(dirname(fileURLToPath(import.meta.url)), "../../../docs/qa/a11y-2026-10.md"); mkdirSync(dirname(report), { recursive: true }); writeFileSync(report, reportText(rows, started));
    const severe = rows.filter((r) => ["serious", "critical"].includes(r.impact)); const failures = checks.filter((x) => !x.ok);
    finish(doc, failures.length || severe.length ? "fail" : "pass", { pages: checks.filter((x) => /Axe/.test(x.name)).length, checks: checks.length, checks_failed: failures.length, axe_violations: rows.length, serious_critical: severe.length, rtl_ltr_checked: checks.filter((x) => /direction/.test(x.name)).length }, failures.length ? failures.map((x) => x.name).join("؛ ") : `التقرير النصي كُتب إلى ${report}`);
    if (parseArgs(argv)["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "browser" }));
    return { code: failures.length || severe.length ? 1 : 0, doc };
  } catch (error) {
    finish(doc, "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${error.message}`);
    if (parseArgs(argv)["dry-run"]) writeResult(doc, { dryRun: true }); else console.log("wrote", writeResult(doc, { slug: "browser-failure" }));
    return { code: 1, doc };
  } finally { await browser?.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit((await run()).code);
