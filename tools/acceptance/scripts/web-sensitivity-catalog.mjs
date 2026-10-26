#!/usr/bin/env node
// يثبت وسم مادة حساسة في نموذج الرفع، ويقارن تفاصيلها بتفاصيل مادة غير موسومة (ضابط)، ثم يتحقق أن دور الكتالوج
// يرى المادة غير الموسومة في البحث ولا يرى الموسومة. غياب الموسومة عن الواجهة لا يثبت غيابها عن API: ذلك لـ pii-leak وtenant-isolation.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, title, syntheticClip, loadPlaywright, login, envDoc, checkList, finishAndWrite, exitCodeFor, EnvironmentError } from "./web-gap-helpers.mjs";

export const MARKER = /حساس|Sensitive|قاصر|Minor|graphic|injur|مصاب/i;

/** وسم الحساسية يظهر في تفاصيل الموسومة ولا يظهر في تفاصيل غير الموسومة نفسها: الفرق هو الدليل لا وجود كلمة عامة في الصفحة. */
export function markerDiffers(sensitiveText, controlText) {
  return MARKER.test(sensitiveText) && !MARKER.test(controlText);
}

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
  await page.getByRole("heading", { name }).waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
  return page.getByRole("main").innerText();
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-sensitivity-catalog", criterion: "المادة الحساسة موسومة في تفاصيلها (بالفرق عن مادة غير موسومة) ولا تظهر في بحث الكتالوج لدور الكتالوج، مع مادة غير موسومة ضابطًا" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_CATALOG_EMAIL", "ACCEPTANCE_CATALOG_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-sensitivity-catalog", { upload_path: "tusd" });
  const { checks, check } = checkList();
  let clip, browser;
  try {
    const { chromium } = await loadPlaywright();
    clip = syntheticClip("web-sensitivity", { seconds: 10 });
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const sensitiveTitle = title("مادة حساسة"), normalTitle = title("مادة غير موسومة");
    const reporter = await browser.newContext(), reporterPage = await reporter.newPage();
    await login(reporterPage, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD });
    const sensitiveText = await upload(reporterPage, env, clip, sensitiveTitle, true);
    const controlText = await upload(reporterPage, env, clip, normalTitle, false);
    check("sensitive details carry a sensitivity mark that an unmarked material's details lack", markerDiffers(sensitiveText, controlText));
    await reporter.close();

    const catalog = await browser.newContext(), page = await catalog.newPage();
    await login(page, env, { email: env.ACCEPTANCE_CATALOG_EMAIL, password: env.ACCEPTANCE_CATALOG_PASSWORD });
    await page.goto(url(env, "/ar/store"), { waitUntil: "domcontentloaded" });
    const search = page.getByLabel(/بحث|Search/i).first();
    if (!(await search.count())) throw new Error("catalog search control is missing");
    const apply = () => page.getByRole("button", { name: /تطبيق|Apply|بحث|Search/i }).first().click();
    const cards = page.getByTestId("catalog-card");
    // الضابط أولًا: مادة غير موسومة تظهر بالبحث نفسه، وإلا فغياب الموسومة قد يكون من البحث لا من المنع
    await search.fill(normalTitle); await apply();
    const controlCard = cards.filter({ hasText: normalTitle });
    const controlCount = await controlCard.count();
    check("unmarked control is visible to the catalog role by the same search", controlCount > 0);
    const exportUi = controlCount > 0 && (await controlCard.first().getByRole("button", { name: /تصدير|Export/i }).count()) > 0;
    await search.fill(sensitiveTitle); await apply();
    const sensitiveCount = await cards.filter({ hasText: sensitiveTitle }).count();
    check("sensitive material is absent from catalog search", sensitiveCount === 0, `cards=${sensitiveCount}`);
    const failures = checks.filter((x) => !x.ok);
    const out = finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "partial", {
      checks: checks.length, checks_failed: failures.length, control_visible: controlCount > 0, sensitive_cards_in_catalog: sensitiveCount,
      export_ui_on_control: exportUi, api_level_absence_checked: false,
    }, failures.length ? failures.map((x) => `${x.name}: ${x.detail}`).join("؛ ") : "غياب المادة الموسومة عن بحث الواجهة بوجود ضابط يظهر بالبحث نفسه؛ غيابها عن API والتصدير لم يُقس هنا (pii-leak وtenant-isolation)، فالنتيجة جزئية؛ مقطع اصطناعي ولا لقطات ولا ملفات محفوظة");
    return { code: failures.length || out.error ? 1 : 0, doc };
  } catch (error) {
    if (error instanceof EnvironmentError) { console.error(`ENVIRONMENT: ${error.message}; nothing measured`); return { code: 2, doc: null }; }
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${error.message}`);
    return { code: exitCodeFor(error), doc };
  } finally { await browser?.close(); clip?.cleanup(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
