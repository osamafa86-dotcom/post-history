#!/usr/bin/env node
// واجهة الويب فقط: مقطع اصطناعي 200MB، قطع offline عشر ثوانٍ عند 30–50% من الملف، ثم استئناف من إزاحة الخادم.
// يحكم على إزاحات PATCH التي يرسلها المتصفح فعلًا. لا يقارن بصمة المخزَّن بالخادم (لا رمز API هنا)، فالنتيجة `partial`.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, title, syntheticClip, loadPlaywright, login, envDoc, checkList, finishAndWrite, exitCodeFor, EnvironmentError } from "./web-gap-helpers.mjs";

export const CUT_WINDOW = [0.3, 0.5];
export const RESEND_BUDGET = 0.1; // أقصى ما يُعاد إرساله بعد الاستئناف، كنسبة من حجم الملف

/**
 * يحكم على إزاحات PATCH المرصودة. `before` أعلى إزاحة بلغها الرفع قبل القطع، و`after` إزاحات ما بعد إعادة الاتصال بترتيبها.
 * الصفر يبقى في القائمة: إعادة الرفع من الصفر هي الفشل المقصود كشفه.
 */
export function assessResume({ before, after, size }) {
  const problems = [];
  if (!(before > 0)) problems.push("the upload never reached the cut window");
  if (after.length === 0) problems.push("no PATCH after the reconnect");
  else {
    if (after.some((offset) => offset === 0)) problems.push("a PATCH restarted from offset zero");
    if (after[0] < before - size * RESEND_BUDGET) problems.push(`the first PATCH after reconnect re-sent more than ${RESEND_BUDGET * 100}% of the file (${after[0]} < ${before})`);
    if (after.some((offset, i) => i > 0 && offset < after[i - 1])) problems.push("PATCH offsets went backwards");
  }
  return problems;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-upload-resume", criterion: "استئناف رفع واجهة الويب بعد انقطاع الشبكة من إزاحة الخادم، دون إعادة من الصفر (بصمة المخزَّن لا تُقارن هنا)" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-upload-resume", { upload_path: "tusd" });
  const { checks, check } = checkList();
  let clip, browser;
  try {
    const { chromium } = await loadPlaywright();
    clip = syntheticClip("web-resume", { seconds: 200, megabytes: 200 });
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const context = await browser.newContext();
    const page = await context.newPage();
    const offsets = [];
    let phase = "before";
    page.on("request", (request) => {
      if (request.method() !== "PATCH") return;
      const h = request.headers()["upload-offset"];
      if (h && /^\d+$/.test(h)) offsets.push({ offset: Number(h), phase });
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
    const [lo, hi] = [clip.size * CUT_WINDOW[0], clip.size * CUT_WINDOW[1]];
    const inWindow = () => offsets.filter((o) => o.phase === "before" && o.offset >= lo && o.offset <= hi);
    const deadline = Date.now() + Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000);
    while (Date.now() < deadline && !inWindow().length) await new Promise((resolve) => setTimeout(resolve, 200));
    const before = Math.max(...inWindow().map((o) => o.offset), 0);
    check("PATCH reached the cut window", before > 0, `offset=${before}, size=${clip.size}, window=${CUT_WINDOW.join("–")}`);
    if (!before) throw new Error("the upload never reached the requested cut window");
    await context.setOffline(true); phase = "offline";
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await context.setOffline(false); phase = "after";
    await page.getByText(/اكتمل الرفع|Upload complete|completed/i).waitFor({ state: "visible", timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) * 4 });
    const after = offsets.filter((o) => o.phase === "after").map((o) => o.offset);
    const problems = assessResume({ before, after, size: clip.size });
    check("resume starts from the server offset, never from zero, within the re-send budget", problems.length === 0, problems.join("; ") || `before=${before}, first_after=${after[0]}`);
    const failures = checks.filter((item) => !item.ok);
    const out = finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "partial", {
      checks: checks.length, checks_failed: failures.length, file_size_bytes: clip.size, interruptions: 1, offline_seconds: 10,
      patch_offsets_before_cut: offsets.filter((o) => o.phase === "before").length, patch_offsets_after_reconnect: after.length, patch_sent_while_offline: offsets.filter((o) => o.phase === "offline").length,
      client_sha256: clip.sha256, stored_sha256_compared: false,
    }, failures.length ? failures.map((x) => `${x.name}: ${x.detail}`).join("؛ ") : "ملف اصطناعي عالي الإنتروبيا مولّد بـffmpeg؛ حُكم على إزاحات PATCH التي أرسلها المتصفح. بصمة المخزَّن لم تُقارن (لا رمز API في هذا السكربت)، فالنتيجة جزئية؛ ولا لقطات ولا ملفات محفوظة");
    return { code: failures.length || out.error ? 1 : 0, doc };
  } catch (error) {
    if (error instanceof EnvironmentError) { console.error(`ENVIRONMENT: ${error.message}; nothing measured`); return { code: 2, doc: null }; }
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1 }, `فشل المسار: ${error.message}`);
    return { code: exitCodeFor(error), doc };
  } finally { await browser?.close(); clip?.cleanup(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
