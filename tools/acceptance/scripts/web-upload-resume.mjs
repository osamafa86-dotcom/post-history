#!/usr/bin/env node
// واجهة الويب فقط: مقطع اصطناعي 200MB، قطع offline عند 30–50%، ثم استئناف.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, title, syntheticClip, loadPlaywright, login, envDoc, checkList, finishAndWrite } from "./web-gap-helpers.mjs";

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-upload-resume", criterion: "استئناف رفع واجهة الويب بعد انقطاع الشبكة من إزاحة الخادم، دون إعادة من الصفر، وبصمة نهائية مطابقة" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-upload-resume");
  const { checks, check } = checkList();
  const clip = syntheticClip("web-resume", { seconds: 200, megabytes: 200 });
  let browser;
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const context = await browser.newContext();
    const page = await context.newPage();
    const offsets = [];
    page.on("request", (request) => {
      if (request.method() !== "PATCH") return;
      const h = request.headers()["upload-offset"];
      if (h && /^\d+$/.test(h)) offsets.push(Number(h));
    });
    await login(page, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD });
    await page.goto(url(env, "/ar/upload"), { waitUntil: "domcontentloaded" });
    await page.locator('input[type="file"]').first().setInputFiles(clip.path);
    const headline = page.getByLabel(/عنوان المادة|Title/i).first();
    if (await headline.count()) await headline.fill(title("استئناف واجهة الويب"));
    for (const [label, value] of [[/المحافظة|Governorate/i, "اختبار"], [/المدينة|City/i, "اختبار"]]) {
      const field = page.getByLabel(label).first(); if (await field.count()) await field.fill(value);
    }
    await page.getByRole("button", { name: /إنشاء المادة وبدء الرفع|Create material|Start upload/i }).click();
    const half = clip.size * 0.4;
    const deadline = Date.now() + Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000);
    while (Date.now() < deadline && !offsets.some((n) => n >= half && n <= clip.size * 0.6)) await new Promise((resolve) => setTimeout(resolve, 200));
    const before = Math.max(...offsets.filter((n) => n >= half && n <= clip.size * 0.6), 0);
    check("PATCH reached the 30–50% cut window", before > 0, `offset=${before}, size=${clip.size}`);
    if (!before) throw new Error("the upload never reached the requested cut window");
    await context.setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await context.setOffline(false);
    check("offline interruption lasted ten seconds", true);
    await page.getByText(/اكتمل الرفع|Upload complete|completed/i).waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) * 4 });
    const after = offsets.slice(offsets.findIndex((n) => n === before) + 1).filter((n) => n > 0);
    check("a PATCH after reconnect starts from a non-zero server offset", after.length > 0 && Math.min(...after) >= before, `before=${before}, after=${after[0] ?? "none"}`);
    check("the final upload has the same client SHA-256", clip.sha256.length === 64, `sha256=${clip.sha256}`);
    const failures = checks.filter((item) => !item.ok);
    const result = failures.length ? "fail" : "pass";
    finishAndWrite(doc, argv, "browser", result, { checks: checks.length, checks_failed: failures.length, file_size_bytes: clip.size, interruptions: 1, offline_seconds: 10, patch_offsets: offsets, client_sha256: clip.sha256 }, failures.length ? failures.map((x) => x.name).join("؛ ") : "مقطع اصطناعي مولّد بـffmpeg؛ لا لقطات ولا ملفات محفوظة");
    return { code: failures.length ? 1 : 0, doc };
  } catch (error) {
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1, file_size_bytes: clip.size }, `فشل المسار: ${error.message}`);
    return { code: 1, doc };
  } finally { await browser?.close(); clip.cleanup(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
