#!/usr/bin/env node
// تدقيق جوال بلا لقطات: صفحات الواجهة الرئيسية بمنظر 390x844 في اللغتين. قياس DOM لصفحة واحدة لكل مسار، لا مراجعة تصميم.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, loadPlaywright, login, envDoc, checkList, finishAndWrite, exitCodeFor, EnvironmentError } from "./web-gap-helpers.mjs";

/** يحكم على قياسات صفحة واحدة؛ يرجع أسماء المخالفات. */
export function judgeLayout(m) {
  const bad = [];
  if (m.horizontal) bad.push("horizontal scroll");
  if (m.outside > 0) bad.push(`${m.outside} action(s) outside the viewport`);
  if (m.cropped > 0) bad.push(`${m.cropped} clipped text element(s)`);
  return bad;
}

async function measure(page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const horizontal = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const visible = (el) => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden"; };
    const outside = [...document.querySelectorAll("button,a,input,select,textarea")].filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > width + 1);
    }).length;
    const cropped = [...document.querySelectorAll("h1,h2,h3,p,label,button,a,[data-testid]")].filter((el) => visible(el) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2).length;
    return { horizontal, outside, cropped, width };
  });
}

async function audit(page, name, check) {
  const metrics = await measure(page);
  const bad = judgeLayout(metrics);
  check(`${name}: layout at 390px`, bad.length === 0, bad.length ? `${bad.join(", ")} ${JSON.stringify(metrics)}` : JSON.stringify(metrics));
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-mobile-390", criterion: "الدخول والرفع والوارد والتفاصيل واللوحة والتنبيهات دون تمرير أفقي أو زر خارج المنظر أو نص مقصوص عند 390px في العربية والإنجليزية" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_SUPERVISOR_EMAIL", "ACCEPTANCE_SUPERVISOR_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-mobile-390");
  const { checks, check } = checkList();
  let browser, skipped = 0;
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const viewport = { width: 390, height: 844 };
    for (const locale of ["ar", "en"]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await login(page, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD, locale });
      await audit(page, `${locale} inbox`, check);
      await page.goto(url(env, `/${locale}/upload`), { waitUntil: "domcontentloaded" }); await audit(page, `${locale} upload`, check);
      await page.goto(url(env, `/${locale}/inbox`), { waitUntil: "domcontentloaded" });
      // رابط مادة بمعرّفها في العنوان داخل المحتوى، لا رابط تنقل
      const link = page.getByRole("main").locator('a[href*="/materials/"], a[href*="/inbox/"]').first();
      if (await link.count()) { await link.click(); await page.waitForLoadState("domcontentloaded"); await audit(page, `${locale} details`, check); }
      else { skipped++; console.log(`skip ${locale} details: no material link in the inbox of this environment`); }
      await page.goto(url(env, `/${locale}/notifications`), { waitUntil: "domcontentloaded" }); await audit(page, `${locale} notifications`, check);
      await context.close();

      const supervisor = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const board = await supervisor.newPage();
      await login(board, env, { email: env.ACCEPTANCE_SUPERVISOR_EMAIL, password: env.ACCEPTANCE_SUPERVISOR_PASSWORD, locale });
      await board.goto(url(env, `/${locale}/board`), { waitUntil: "domcontentloaded" }); await audit(board, `${locale} board`, check);
      await supervisor.close();
    }
    const failures = checks.filter((x) => !x.ok);
    // ما لم يُدقَّق (مسار بلا بيانات في البيئة) يمنع `pass`
    const out = finishAndWrite(doc, argv, "browser", failures.length ? "fail" : skipped ? "partial" : "pass",
      { checks: checks.length, checks_failed: failures.length, skipped_routes: skipped, viewport_width: 390, viewport_height: 844, locales: ["ar", "en"] },
      failures.length ? failures.map((x) => `${x.name}: ${x.detail}`).join("؛ ") : "قياس DOM لصفحة واحدة لكل مسار ودور عند 390×844؛ لا لقطات محفوظة ولا مراجعة تصميم؛ المواد والوسائط اصطناعية فقط");
    return { code: failures.length || out.error ? 1 : 0, doc };
  } catch (error) {
    if (error instanceof EnvironmentError) { console.error(`ENVIRONMENT: ${error.message}; nothing measured`); return { code: 2, doc: null }; }
    finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1, viewport_width: 390 }, `فشل المسار: ${error.message}`);
    return { code: exitCodeFor(error), doc };
  } finally { await browser?.close(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
