// قياس #88: رفع ملف اصطناعي من Chromium إلى tusd محلي حقيقي، مع قتل tusd أثناء الرفع وإعادة تشغيله.
// المعيار: صفر بايت مفقود = بصمة الملف المجمّع عند tusd تطابق بصمة المصدر، والإزاحة تساوي الحجم.
// يحتاج: Redis، وملف tusd التنفيذي (TUSD_BIN، v2.10.1 كما في compose)، و`npm run build` مسبقًا. بيانات اصطناعية فقط.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };

const size = Number(process.env.UPLOAD_MEASURE_BYTES ?? 1024 ** 3), cutAt = Number(process.env.UPLOAD_MEASURE_CUT_RATIO ?? 0.4);
const tusdBin = process.env.TUSD_BIN ?? "tusd", redis = process.env.WEB_TEST_REDIS_URL ?? "redis://127.0.0.1:6381/1";
const work = mkdtempSync(join(tmpdir(), "upload-measure-")), store = join(work, "tusd"), source = join(work, "A001C001_SYNTH.MOV");
const output = process.env.WEB_MEASUREMENT_OUTPUT ?? `../../docs/measurements/web/${new Date().toISOString().slice(0, 10)}-desktop-upload-resume.json`;
const children: ChildProcess[] = [];
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, timeout: number, label: string) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await check()) return; } catch { /* لم يجهز بعد */ } await wait(200); }
  throw new Error(`Timed out: ${label}`);
}
function run(command: string, args: string[], env: Record<string, string> = {}) {
  // مجموعة عمليات مستقلة: إنهاؤها يُنهي ما تفرّع عنها (npx ← next-server) فلا يبقى خادم قديم على المنفذ.
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"], detached: true });
  children.push(child); return child;
}
const tusd = () => run(tusdBin, ["-host", "127.0.0.1", "-port", "1080", "-base-path", "/files/", "-upload-dir", store, "-disable-download",
  "-cors-allow-origin", "^http://127\\.0\\.0\\.1:3100$", "-cors-allow-headers", "Ingest-Token", "-verbose=false"]);
const received = () => { const id = readdirSync(store).find(name => !name.endsWith(".info") && !name.endsWith(".lock")); return id ? statSync(join(store, id)).size : 0; };
async function sha256(path: string) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }

async function main() {
  // ملف اصطناعي عشوائي على القرص: إعادة اختياره تعطي البصمة نفسها، ولا يحمل أي محتوى.
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(source); let left = size;
    const write = () => { while (left > 0) { const n = Math.min(left, 8 * 1048576); left -= n; if (!out.write(randomBytes(n))) return void out.once("drain", write); } out.end(); };
    out.on("finish", resolve).on("error", reject); write();
  });
  const expected = await sha256(source);
  let server = tusd();
  run("node", ["--import", "tsx", "scripts/fixture-api.ts"], { FIXTURE_TUS_ENDPOINT: "http://127.0.0.1:1080/files/", FIXTURE_PART_SIZE: String(16 * 1048576) });
  run("npx", ["next", "start", "--hostname", "127.0.0.1", "--port", "3100"], {
    NEXT_TELEMETRY_DISABLED: "1", WEB_ORIGIN: "http://127.0.0.1:3100", API_BASE_URL: "http://127.0.0.1:3201/v1", WEB_ALLOW_INSECURE_LOCALHOST: "true",
    WEB_MEDIA_ORIGINS: "http://127.0.0.1:3201", WEB_TUS_ORIGINS: "http://127.0.0.1:1080", WEB_REDIS_URL: redis, WEB_SESSION_KEY: randomBytes(32).toString("base64"),
  });
  await until(async () => (await fetch("http://127.0.0.1:3201/health")).ok, 30000, "fixture api");
  await until(async () => (await fetch("http://127.0.0.1:3100/ar/login")).ok, 60000, "web");
  await until(async () => (await fetch("http://127.0.0.1:1080/files/", { method: "OPTIONS" })).status < 500, 10000, "tusd");

  const browser = await chromium.launch(), page = await browser.newPage();
  const started = new Date();
  await page.goto("http://127.0.0.1:3100/ar/login");
  await page.getByLabel(ar.email).fill("reporter@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await page.waitForURL(/\/ar\/inbox/); await page.goto("http://127.0.0.1:3100/ar/upload");
  await page.getByLabel(ar.upload.choose).setInputFiles(source);
  await page.getByLabel(ar.upload.titleLabel).fill("قياس رفع اصطناعي"); await page.getByLabel(ar.governorate, { exact: true }).fill("اختبار"); await page.getByLabel(ar.upload.city).fill("اختبار");
  await page.locator("#field-headline").fill("قياس"); await page.locator("#field-category").selectOption("news"); await page.locator("#field-consent").selectOption("true");
  const clicked = Date.now();
  await page.getByRole("button", { name: ar.upload.start }).click();
  const row = page.getByTestId("upload-row");
  await until(async () => await row.getAttribute("data-phase") === "uploading", 15 * 60000, "hash");
  const hashed = Date.now();
  await until(() => received() >= size * cutAt, 15 * 60000, "first part of upload");
  // القطع المتعمد: قتل tusd (SIGKILL، لا إغلاق نظيف) ثم إعادته بعد 5 ثوانٍ على المخزن نفسه.
  const atCut = received(); process.kill(-server.pid!, "SIGKILL"); const cut = Date.now();
  await wait(5000); server = tusd();
  await until(() => received() > atCut, 120000, "resume after restart");
  const resumed = Date.now();
  await until(async () => ["processing", "done"].includes(await row.getAttribute("data-phase") ?? ""), 30 * 60000, "upload end");
  const finished = Date.now();
  const id = readdirSync(store).find(name => !name.endsWith(".info") && !name.endsWith(".lock"))!;
  const final = statSync(join(store, id)).size, actual = await sha256(join(store, id));
  const version = browser.version(); await browser.close();
  const pass = final === size && actual === expected;
  const result = {
    schema_version: 1, tool: "web", role: "web-agent", test_name: "desktop-upload-resume", started_at: started.toISOString(), ended_at: new Date().toISOString(),
    result: pass ? "partial" : "fail", upload_path: "tusd",
    device: { platform: "browser", model: `Chromium ${version} (Playwright headless), ${cpus().length} vCPU, ${Math.round(totalmem() / 1024 ** 3)} GiB`, os_version: `Linux ${release()}` },
    network: { profile: "loopback-127.0.0.1" },
    file: { size_bytes: size },
    metrics: {
      bytes_lost: size - final, sha256_match: actual === expected, final_offset_bytes: final, part_size_bytes: 16 * 1048576,
      offset_at_cut_bytes: atCut, server_down_s: +((resumed - cut) / 1000).toFixed(1), browser_hash_s: +((hashed - clicked) / 1000).toFixed(1),
      browser_hash_mb_per_s: +(size / 1048576 / ((hashed - clicked) / 1000)).toFixed(1), upload_s_including_outage: +((finished - hashed) / 1000).toFixed(1),
      tusd_version: "v2.10.1", ingest_gate: false, safari_measured: false,
    },
    notes: "ملف عشوائي اصطناعي 1 GiB من القرص عبر setInputFiles، وtusd v2.10.1 محلي على loopback بلا بوابة ingest وبلا خطّافات (API اصطناعي). القطع: SIGKILL لـ tusd عند 40% وإعادته بعد 5 ث على المخزن نفسه؛ استأنف العميل بـ HEAD من إزاحة الخادم. bytes_lost = الحجم ناقص ما جُمّع، والمطابقة ببصمة SHA-256 الكاملة. partial: Chromium وحده (Safari غير متاح في بيئة Linux)، وعلى loopback لا شبكة حقيقية ولا بوابة؛ يُعاد على جهاز فعلي وعبر البوابة قبل pass.",
  };
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.metrics));
  if (!pass) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for (const child of children) { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* انتهت */ } } rmSync(work, { recursive: true, force: true }); });
