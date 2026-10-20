import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import ar from "../messages/ar.json";

const origin = "http://127.0.0.1:3100", started = new Date(), samples: number[] = [];
const browser = await chromium.launch();
try {
  for (let index = 0; index < 5; index++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ar" });
    try {
      const login = await context.request.post(`${origin}/api/bff/auth/login`, { headers: { Origin: origin, "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID() }, data: { email: "fixture@example.test", password: "synthetic-password", totp_code: "123456" } });
      if (!login.ok()) throw new Error("Synthetic login failed");
      const page = await context.newPage();
      await page.goto(`${origin}/ar/inbox`);
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="material-row"]').length === 50);
      const firstRender = await page.evaluate(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); return performance.now(); });
      samples.push(firstRender);
      if (index === 0) {
        mkdirSync(".artifacts", { recursive: true });
        await page.screenshot({ path: ".artifacts/inbox-desktop.png", fullPage: false });
        let total = 50;
        for (let number = 2; number <= 4; number++) {
          await page.getByRole("button", { name: ar.next, exact: true }).click();
          await page.waitForFunction(() => document.querySelectorAll('[data-testid="material-row"]').length === 50);
          total += await page.getByTestId("material-row").count();
        }
        if (total !== 200 || !(await page.getByRole("button", { name: ar.next, exact: true }).isDisabled())) throw new Error("Seeded material count mismatch");
      }
      await context.request.post(`${origin}/api/bff/auth/logout`, { headers: { Origin: origin, "X-Requested-With": "post-history-web" }, data: { all_sessions: false } });
    } finally { await context.close(); }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const result = {
    schema_version: 1, tool: "web", role: "web", test_name: "inbox-first-render-200-seeded", started_at: started.toISOString(), ended_at: new Date().toISOString(), result: "info",
    device: { platform: "browser", model: `Chromium ${browser.version()}, 1440x1000`, os_version: `${os.type()} ${os.release()}` },
    network: { profile: "local-loopback-no-throttling" }, upload_path: "n/a",
    metrics: { seed_material_count: 200, visible_first_page_count: 50, samples: samples.length,
      first_render_ms_min: +sorted[0].toFixed(2), first_render_ms_median: +sorted[2].toFixed(2), first_render_ms_max: +sorted[4].toFixed(2),
      first_render_ms_runs: samples.map(n => n.toFixed(2)).join(","), fresh_browser_context_each_run: true, production_next_build: true,
      backend: "synthetic contract API + real Redis session store", node_version: process.version },
    notes: "قياس مباشر من navigationStart حتى ظهور 50 صفًا ثم إطارَي رسم، في بناء Next.js للإنتاج. خادم API اصطناعي يزرع 200 مادة؛ جرى اجتياز الصفحات الأربع للتحقق من العدد. BFF ومخزن Redis حقيقيان؛ لا PostgreSQL ولا شبكة ميدانية ولا بيانات مراسلين. خمسة سياقات متصفح جديدة وخادم دافئ. النتيجة معلوماتية وليست معيار قبول أو إثبات أداء المنظومة الكاملة.",
  };
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true }); addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync("../../contracts/schemas/measurement.json", "utf8")));
  if (!validate(result)) throw new Error(ajv.errorsText(validate.errors));
  const out = path.resolve(process.env.WEB_MEASUREMENT_OUTPUT ?? `../../docs/measurements/web/${started.toISOString().slice(0, 10)}-inbox-first-render.json`);
  mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ output: out, samples_ms: samples.map(n => +n.toFixed(2)), schema_valid: true }));
} finally { await browser.close(); }
