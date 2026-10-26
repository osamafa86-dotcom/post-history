#!/usr/bin/env node
// تدقيق جوال بلا لقطات: صفحات الواجهة الرئيسية ب viewport 390x844 في اللغتين.
import { banner } from "../lib/measurement.mjs";
import { envMissing, url, loadPlaywright, login, envDoc, checkList, finishAndWrite } from "./web-gap-helpers.mjs";

async function audit(page, name, check) {
  const metrics = await page.evaluate(() => {
    const width = window.innerWidth;
    const horizontal = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const outside = [...document.querySelectorAll("button,a,input,select,textarea")].filter((el) => {
      const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > width + 1);
    }).length;
    const cropped = [...document.querySelectorAll("h1,h2,h3,p,label,button,a,[data-testid]")].filter((el) => {
      const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden") return false;
      return el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2;
    }).length;
    return { horizontal, outside, cropped, width };
  });
  check(`${name}: no horizontal scroll`, !metrics.horizontal, JSON.stringify(metrics));
  check(`${name}: no visible action outside viewport`, metrics.outside === 0, JSON.stringify(metrics));
  check(`${name}: no clipped visible text`, metrics.cropped === 0, JSON.stringify(metrics));
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  banner({ name: "web-mobile-390", criterion: "الدخول والرفع والوارد والتفاصيل واللوحة والتنبيهات دون تمرير أفقي أو زر خارج المنظر أو نص مقصوص عند 390px في العربية والإنجليزية" });
  const missing = envMissing(env, ["ACCEPTANCE_BASE_URL", "ACCEPTANCE_REPORTER_EMAIL", "ACCEPTANCE_REPORTER_PASSWORD", "ACCEPTANCE_SUPERVISOR_EMAIL", "ACCEPTANCE_SUPERVISOR_PASSWORD"]);
  if (missing.length) { console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`); return { code: 2, doc: null }; }
  const doc = envDoc(env, "web-mobile-390"); const { checks, check } = checkList(); let browser;
  try {
    const { chromium } = await loadPlaywright(); browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    for (const locale of ["ar", "en"]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await login(page, env, { email: env.ACCEPTANCE_REPORTER_EMAIL, password: env.ACCEPTANCE_REPORTER_PASSWORD, locale });
      await audit(page, `${locale} login/inbox`, check);
      await page.goto(url(env, `/${locale}/upload`), { waitUntil: "domcontentloaded" }); await audit(page, `${locale} upload`, check);
      await page.goto(url(env, `/${locale}/inbox`), { waitUntil: "domcontentloaded" });
      const link = page.getByRole("link").filter({ hasText: /لقطات|Synthetic|مادة|Material/i }).first();
      if (await link.count()) { await link.click(); await page.waitForLoadState("domcontentloaded"); await audit(page, `${locale} details`, check); }
      else check(`${locale} details route is available`, false, "no material link in inbox");
      await page.goto(url(env, `/${locale}/notifications`), { waitUntil: "domcontentloaded" }); await audit(page, `${locale} notifications`, check);
      await context.close();

      const supervisor = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      const board = await supervisor.newPage();
      await login(board, env, { email: env.ACCEPTANCE_SUPERVISOR_EMAIL, password: env.ACCEPTANCE_SUPERVISOR_PASSWORD, locale });
      await board.goto(url(env, `/${locale}/board`), { waitUntil: "domcontentloaded" }); await audit(board, `${locale} board`, check);
      await supervisor.close();
    }
    const failures = checks.filter((x) => !x.ok); finishAndWrite(doc, argv, "browser", failures.length ? "fail" : "pass", { checks: checks.length, checks_failed: failures.length, viewport_width: 390, viewport_height: 844, locales: ["ar", "en"] }, failures.length ? failures.map((x) => x.name).join("؛ ") : "قياسات DOM فقط؛ لا لقطات محفوظة؛ المواد والوسائط الاصطناعية فقط");
    return { code: failures.length ? 1 : 0, doc };
  } catch (error) { finishAndWrite(doc, argv, "browser-failure", "fail", { checks: checks.length, checks_failed: 1, viewport_width: 390 }, `فشل المسار: ${error.message}`); return { code: 1, doc }; }
  finally { await browser?.close(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) process.exit((await run()).code);
