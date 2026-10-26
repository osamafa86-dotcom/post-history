#!/usr/bin/env node
// يثبت وسم مادة حساسة، ثم يمنع ظهورها في الكتالوج والبحث والتصدير.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, title, syntheticClip, loadPlaywright, login, envDoc, checkList, finishAndWrite } from "./web-gap-helpers.mjs";

async function upload(page, env, clip, name, sensitive) {
  await page.goto(url(env, "/ar/upload"), { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').first().setInputFiles(clip.path);
  await page.getByLabel(/عنوان المادة|Title/i).first().fill(name);
  for (const [label, value] of [[/المحافظة|Governorate/i, "اختبار"], [/المدينة|City/i, "اختبار"]]) {
    const field = page.getByLabel(label).first(); if (await field.count()) await field.fill(value);
  }
  if (sensitive) {
    const candidates = page.getByLabel(/قاصر|مصاب|حساس|graphic|minor|injur/i);
    if (await candidates.count()) await candidates.first().check();
    else throw new Error("sensitivity controls are missing from the upload form");
  }
  await page.getByRole("button", { name: /إنشاء المادة وبدء الرفع|Create material|Start upload/i }).click();
  await page.getByText(/اكتمل الرفع|Upload complete|completed/i).waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) * 2 });
  const link = page.getByRole("link", { name }).first();
  await link.waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
  await link.click();
  return name;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-sensitivity-catalog", criterion: "المادة الحساسة موسومة في تفاصيلها ولا تظهر في الكتالوج أو البحث أو التصدير، مع مادة غير موسومة كضابط" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_CATALOG_EMAIL", "ACCEPTANCE_CATALOG_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-sensitivity-catalog"); const { checks, check } = checkList();
  const clip = syntheticClip("web-sensitivity", { seconds: 10 });
  let browser;
  try {
    const { chromium } = await loadPlaywright(); browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const reporter = await browser.newContext(); const reporterPage = await reporter.newPage();
    await login(reporterPage, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD });
    const sensitiveTitle = title("مادة حساسة"); const normalTitle = title("مادة غير موسومة");
    await upload(reporterPage, env, clip, sensitiveTitle, true);
    const sensitiveBody = await reporterPage.locator("body").innerText();
    check("sensitive material shows its sensitivity mark in details", /حساس|Sensitive|قاصر|Minor|graphic|injur/i.test(sensitiveBody), "details page");
    await reporterPage.getByRole("button", { name: /تسجيل الخروج|Sign out|Logout/i }).click().catch(() => {});
    await login(reporterPage, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD });
    await upload(reporterPage, env, clip, normalTitle, false);
    check("an unmarked control material can be created", true);
    await reporter.close();

    const catalog = await browser.newContext(); const page = await catalog.newPage();
    await login(page, env, { email: env.ACCEPTANCE_CATALOG_EMAIL, password: env.ACCEPTANCE_CATALOG_PASSWORD });
    await page.goto(url(env, "/ar/store"), { waitUntil: "domcontentloaded" });
    const sensitiveSearch = page.getByLabel(/بحث|Search/i).first();
    if (!(await sensitiveSearch.count())) throw new Error("catalog search control is missing");
    await sensitiveSearch.fill(sensitiveTitle); await page.getByRole("button", { name: /تطبيق|Apply|بحث|Search/i }).first().click();
    const sensitiveCards = page.getByTestId("catalog-card");
    check("sensitive material is absent from catalog search", await sensitiveCards.filter({ hasText: sensitiveTitle }).count() === 0);
    await sensitiveSearch.fill(normalTitle); await page.getByRole("button", { name: /تطبيق|Apply|بحث|Search/i }).first().click();
    const controlCount = await sensitiveCards.filter({ hasText: normalTitle }).count();
    check("unmarked control is visible to catalog role", controlCount > 0);
    const exportButtons = page.getByRole("button", { name: /تصدير|Export/i });
    const partial = !(await exportButtons.count());
    if (partial) console.log("PARTIAL export UI is not available in this environment");
    else {
      await sensitiveSearch.fill(sensitiveTitle); await page.getByRole("button", { name: /تطبيق|Apply|بحث|Search/i }).first().click();
      check("sensitive material has no export action", await exportButtons.count() === 0);
    }
    const failures = checks.filter((x) => !x.ok); const result = failures.length ? "fail" : partial ? "partial" : "pass";
    finishAndWrite(doc, argv, "browser", result, { checks: checks.length, checks_failed: failures.length, sensitive_absent_from_catalog: !failures.some((x) => /catalog/.test(x.name)), control_visible: controlCount > 0, export_checked: !partial }, failures.length ? failures.map((x) => x.name).join("؛ ") : partial ? "واجهة التصدير غير موجودة في هذه البيئة؛ بقية فحوص الحساسية والكتالوج مقاسة" : "مقطع اصطناعي مولّد بـffmpeg؛ لا لقطات ولا ملفات محفوظة");
    return { code: failures.length ? 1 : 0, doc };
  } catch (error) {
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${error.message}`); return { code: 1, doc };
  } finally { await browser?.close(); clip.cleanup(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
