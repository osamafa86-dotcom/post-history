#!/usr/bin/env node
// web-e2e: مسار الويب من الرفع إلى التنبيه: مراسل يرفع مقطعًا اصطناعيًا، محرر يراه في الوارد ويغيّر حالته التحريرية،
// ثم يظهر تنبيه يحمل عنوان المادة. يقيس زمن ظهور التنبيه مرة واحدة؛ لا يكرر ولا يقيس التصعيد، فالنتيجة `partial` دائمًا
// (صف «إشعار الاستلام» يطلب 95% من الاختبارات خلال 60 ثانية). لا يختبر حدود الصلاحيات ولا الحقول المتغيرة.
// التشغيل:
//   ACCEPTANCE_BASE_URL=… ACCEPTANCE_REPORTER_EMAIL=… ACCEPTANCE_REPORTER_PASSWORD=… \
//   ACCEPTANCE_EDITOR_EMAIL=… ACCEPTANCE_EDITOR_PASSWORD=… node tools/acceptance/scripts/web-e2e.mjs
// لا يكتب هذا الملف أي قيمة اعتماد ولا يضيف ملف وسائط إلى المستودع. يحتاج playwright في apps/web أو PLAYWRIGHT_MODULE.
import { banner } from "../lib/measurement.mjs";
import { scrub, envMissing, url, title, syntheticClip, loadPlaywright, login, envDoc, checkList, finishAndWrite, exitCodeFor, EnvironmentError } from "./web-gap-helpers.mjs";

const NOTIFICATION_WAIT_S = 90;

async function fillIfPresent(page, label, value) {
  const field = page.getByLabel(label).first();
  if (await field.count()) await field.fill(value);
}

async function selectIfPresent(page, label, option) {
  const field = page.getByLabel(label).first();
  if (await field.count()) {
    const options = await field.locator("option").allTextContents();
    const match = options.find((text) => text.trim() === option);
    if (match) await field.selectOption({ label: match.trim() });
  }
}

async function uploadAsReporter(page, env, clip, name) {
  await page.goto(url(env, "/ar/upload"), { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').first().setInputFiles(clip.path);
  await fillIfPresent(page, /عنوان المادة|Title/i, name);
  await selectIfPresent(page, /نوع المادة|Type/i, "لقطات خام");
  await fillIfPresent(page, /المحافظة|Governorate/i, "اختبار");
  await fillIfPresent(page, /المدينة|City/i, "اختبار");
  await page.getByRole("button", { name: /إنشاء المادة وبدء الرفع|Create material|Start upload/i }).click();
  await page.getByText(/اكتمل الرفع|Upload complete|completed/i).waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
  await page.getByRole("link", { name }).first().waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
}

async function findMaterialInEditor(page, env, name) {
  const timeout = Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000);
  await page.goto(url(env, "/ar/inbox"), { waitUntil: "domcontentloaded" });
  const material = page.getByRole("link", { name }).first();
  await material.waitFor({ state: "visible", timeout });
  await material.click();
  await page.getByRole("heading", { name }).waitFor({ state: "visible", timeout });
}

/** يغيّر الحالة التحريرية ويرجع الحالة المختارة؛ التحقق بنص خارج قوائم الخيارات فلا يطابق الخيار نفسه. */
async function changeEditorialState(page, env) {
  const selects = page.locator("select");
  if (await selects.count() < 2) throw new Error("editorial transition controls are missing");
  const state = selects.nth(1);
  const options = await state.locator("option").allTextContents();
  const wanted = options.find((text) => /اطّلع عليها|قيد المراجعة|Acknowledged|In review/i.test(text));
  if (!wanted) throw new Error("no editorial target state is available");
  await state.selectOption({ label: wanted.trim() });
  const reason = page.locator("textarea").first();
  if (await reason.count()) await reason.fill("اختبار قبول آلي");
  await page.getByRole("button", { name: /تنفيذ التحويل|Apply transition|Change status/i }).click();
  const text = new RegExp(wanted.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  await page.getByText(text).and(page.locator(":not(option)")).first().waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
  return wanted.trim();
}

/** يعيد تحميل صفحة التنبيهات حتى يظهر تنبيه يحمل عنوان المادة، ويرجع الزمن بالثواني أو null عند انقضاء المهلة. */
async function notificationLatency(page, env, name, startedAt) {
  const deadline = Date.now() + NOTIFICATION_WAIT_S * 1000;
  while (Date.now() < deadline) {
    await page.goto(url(env, "/ar/notifications"), { waitUntil: "domcontentloaded" });
    if (await page.getByRole("main").getByText(name).count()) return Number(((Date.now() - startedAt) / 1000).toFixed(1));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-e2e", criterion: "مسار الويب: رفع → وارد المحرر → تغيير الحالة التحريرية → ظهور تنبيه بعنوان المادة (مرة واحدة، دون قياس 95% ولا التصعيد)" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_EDITOR_EMAIL", "ACCEPTANCE_EDITOR_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "receipt-notification", { upload_path: "tusd" });
  const { checks, check } = checkList();
  const name = title("اختبار قبول ويب");
  let clip, browser;
  try {
    const { chromium } = await loadPlaywright();
    clip = syntheticClip("web-e2e", { seconds: 10 });
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const reporter = await browser.newContext(), reporterPage = await reporter.newPage();
    await login(reporterPage, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD });
    await uploadAsReporter(reporterPage, env, clip, name);
    check("reporter login and synthetic upload", true);
    await reporter.close();

    const editor = await browser.newContext(), editorPage = await editor.newPage();
    await login(editorPage, env, { email: env.ACCEPTANCE_EDITOR_EMAIL, password: env.ACCEPTANCE_EDITOR_PASSWORD });
    await findMaterialInEditor(editorPage, env, name);
    check("material appears in the editor inbox", true);
    const startedAt = Date.now();
    const state = await changeEditorialState(editorPage, env);
    check("editor changes the editorial state", true, state);
    const latency = await notificationLatency(editorPage, env, name, startedAt);
    check(`a notification carrying the material title appears within ${NOTIFICATION_WAIT_S} s`, latency !== null, latency === null ? "not seen" : `${latency} s`);
    await editor.close();

    const failures = checks.filter((item) => !item.ok);
    const out = finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "partial", {
      checks: checks.length, checks_failed: failures.length, notification_latency_s: latency ?? "unverified", runs: 1, escalation_measured: false,
    }, failures.length ? failures.map((item) => `${item.name}: ${item.detail}`).join("؛ ") : "مسار واحد بمقطع اصطناعي مولّد بـffmpeg؛ زمن ظهور التنبيه بعد تغيير الحالة مقيس مرة واحدة، لا 95% من الاختبارات ولا التصعيد ولا زمن التحقق الفني، فالنتيجة جزئية؛ لم تُحفظ وسائط والحسابات من البيئة فقط");
    return { code: failures.length || out.error ? 1 : 0, doc };
  } catch (error) {
    if (error instanceof EnvironmentError) { console.error(`ENVIRONMENT: ${scrub(error.message)}; nothing measured`); return { code: 2, doc: null }; }
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${scrub(error.message)}`);
    return { code: exitCodeFor(error), doc };
  } finally { await browser?.close(); clip?.cleanup(); }
}

if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
