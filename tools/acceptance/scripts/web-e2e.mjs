#!/usr/bin/env node
// web-e2e: اختبار قبول الويب من الرفع إلى التنبيه.
// يغطي صفوف الخطة: «الحقول المتغيرة»، «إشعار الاستلام»، وحدود الصلاحيات عبر الوارد الحي.
// التشغيل:
//   ACCEPTANCE_BASE_URL="$BASE_URL" \
//   ACCEPTANCE_REPORTER_EMAIL="$REPORTER_EMAIL" \
//   ACCEPTANCE_REPORTER_PASSWORD="$REPORTER_PASSWORD" \
//   ACCEPTANCE_EDITOR_EMAIL="$EDITOR_EMAIL" \
//   ACCEPTANCE_EDITOR_PASSWORD="$EDITOR_PASSWORD" \
//   node tools/acceptance/scripts/web-e2e.mjs
// لا يكتب هذا الملف أي قيمة اعتماد ولا يضيف ملف وسائط إلى المستودع.

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newResult, finish, writeResult, parseArgs, banner } from "../lib/measurement.mjs";
import { byName } from "../lib/catalog.mjs";

const TEST_NAME = "web-e2e";
const TITLE = `اختبار قبول ويب ${Date.now()}`;
const timeoutMs = Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 30_000);

function requiredEnv(env = process.env) {
  return [
    "ACCEPTANCE_BASE_URL",
    "ACCEPTANCE_REPORTER_EMAIL",
    "ACCEPTANCE_REPORTER_PASSWORD",
    "ACCEPTANCE_EDITOR_EMAIL",
    "ACCEPTANCE_EDITOR_PASSWORD",
  ].filter((key) => !env[key]);
}

function route(base, path) {
  return new URL(path, `${base.replace(/\/$/, "")}/`).toString();
}

function makeSyntheticClip(dir) {
  const output = join(dir, "web-e2e-synthetic.mp4");
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", output,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr || "unknown error"}`);
  return output;
}

async function fillLogin(page, email, password) {
  await page.goto(route(process.env.ACCEPTANCE_BASE_URL, "/ar/login"), { waitUntil: "domcontentloaded" });
  await page.getByLabel(/البريد الإلكتروني|Email/i).fill(email);
  await page.getByLabel(/كلمة المرور|Password/i).fill(password);
  await page.getByRole("button", { name: /دخول|Sign in|Login/i }).click();
  await page.waitForURL(/\/((ar|en)\/)?inbox(?:\?|$)/, { timeout: timeoutMs });
}

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

async function uploadAsReporter(page, clip) {
  await page.goto(route(process.env.ACCEPTANCE_BASE_URL, "/ar/upload"), { waitUntil: "domcontentloaded" });
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(clip);
  await fillIfPresent(page, /عنوان المادة|Title/i, TITLE);
  await selectIfPresent(page, /نوع المادة|Type/i, "لقطات خام");
  await fillIfPresent(page, /المحافظة|Governorate/i, "اختبار");
  await fillIfPresent(page, /المدينة|City/i, "اختبار");
  await page.getByRole("button", { name: /إنشاء المادة وبدء الرفع|Create material|Start upload/i }).click();
  await page.getByText(/اكتمل الرفع|Upload complete|completed/i).waitFor({ state: "visible", timeout: timeoutMs });
  const materialLink = page.getByRole("link", { name: TITLE }).first();
  await materialLink.waitFor({ state: "visible", timeout: timeoutMs });
  return materialLink;
}

async function findMaterialInEditor(page) {
  await page.goto(route(process.env.ACCEPTANCE_BASE_URL, "/ar/inbox"), { waitUntil: "domcontentloaded" });
  const material = page.getByRole("link", { name: TITLE }).first();
  await material.waitFor({ state: "visible", timeout: timeoutMs });
  await material.click();
  await page.getByRole("heading", { name: TITLE }).waitFor({ state: "visible", timeout: timeoutMs });
}

async function changeEditorialState(page) {
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
  await page.getByText(new RegExp(wanted.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).waitFor({ state: "visible", timeout: timeoutMs });
}

async function verifyNotification(page) {
  await page.goto(route(process.env.ACCEPTANCE_BASE_URL, "/ar/notifications"), { waitUntil: "domcontentloaded" });
  const body = await page.locator("body").innerText();
  if (!body.includes(TITLE) && !/تحديث على مادة|Material update|notification/i.test(body)) {
    throw new Error("no notification for the changed material was visible");
  }
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const entry = byName("receipt-notification");
  banner({ name: TEST_NAME, criterion: `${entry?.criterion ?? "إشعار الاستلام"}؛ مسار الويب: رفع → وارد المحرر → تغيير الحالة التحريرية → ظهور التنبيه` });
  const missing = requiredEnv(env);
  if (missing.length) {
    console.error(`ENVIRONMENT: missing ${missing.join(", ")}; nothing measured`);
    return { code: 2, doc: null };
  }
  const work = mkdtempSync(join(tmpdir(), "post-history-web-e2e-"));
  const started = new Date().toISOString();
  const doc = newResult(TEST_NAME, {
    started_at: started,
    device: { platform: "browser", model: "Playwright" },
    network: { profile: env.ACCEPTANCE_NETWORK_PROFILE ?? "default" },
    upload_path: "web",
    file: { codec: "synthetic H.264", duration_s: 10 },
  });
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  let browser;
  try {
    const clip = makeSyntheticClip(work);
    const sha256 = createHash("sha256").update(readFileSync(clip)).digest("hex");
    browser = await chromium.launch({ headless: env.ACCEPTANCE_HEADLESS !== "0" });
    const reporter = await browser.newContext();
    const reporterPage = await reporter.newPage();
    await fillLogin(reporterPage, env.ACCEPTANCE_REPORTER_EMAIL, env.ACCEPTANCE_REPORTER_PASSWORD);
    await uploadAsReporter(reporterPage, clip);
    check("reporter login and synthetic upload", true, `sha256=${sha256}`);
    await reporter.close();

    const editor = await browser.newContext();
    const editorPage = await editor.newPage();
    await fillLogin(editorPage, env.ACCEPTANCE_EDITOR_EMAIL, env.ACCEPTANCE_EDITOR_PASSWORD);
    await findMaterialInEditor(editorPage);
    check("material appears in editor inbox", true);
    await changeEditorialState(editorPage);
    check("editor changes the editorial state", true);
    await verifyNotification(editorPage);
    check("notification appears after the editorial change", true);
    await editor.close();

    const failed = checks.filter((item) => !item.ok);
    finish(doc, failed.length ? "fail" : "pass", {
      checks: checks.length,
      checks_passed: checks.filter((item) => item.ok).length,
      checks_failed: failed.length,
      synthetic_clip: true,
      clip_sha256: sha256,
      material_title: TITLE,
    }, failed.length ? failed.map((item) => `${item.name}: ${item.detail}`).join("؛ ") : "مقطع اصطناعي مولّد بـffmpeg؛ لم تُحفظ وسائط في المستودع؛ الحسابات والقيم تقرأ من متغيرات البيئة فقط");
    if (args["dry-run"]) writeResult(doc, { dryRun: true });
    else console.log("wrote", writeResult(doc, { slug: "browser" }));
    return { code: failed.length ? 1 : 0, doc };
  } catch (error) {
    finish(doc, "fail", { checks: checks.length, checks_passed: checks.filter((item) => item.ok).length, checks_failed: 1 }, `فشل المسار: ${error.message}`);
    if (args["dry-run"]) writeResult(doc, { dryRun: true });
    else console.log("wrote", writeResult(doc, { slug: "browser-failure" }));
    return { code: 1, doc };
  } finally {
    await browser?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit((await run()).code);
