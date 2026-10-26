import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";

/** غياب المتصفح أو متغيرات البيئة خلل بيئة لا فشل مقيس: يخرج بالرمز 2 ولا يكتب نتيجة. */
export class EnvironmentError extends Error {
  name = "EnvironmentError";
}

export async function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    "@playwright/test",
    "../../../apps/web/node_modules/@playwright/test/index.mjs",
  ].filter(Boolean);
  let last;
  for (const spec of candidates) {
    try { return await import(spec); } catch (e) { last = e; }
  }
  throw new EnvironmentError(`Playwright is unavailable: ${last?.message ?? "install it in the web workspace"}`);
}

export function envMissing(env, keys) { return keys.filter((key) => !env[key]); }
export function baseUrl(env) { return env.ACCEPTANCE_BASE_URL.replace(/\/$/, ""); }
export function url(env, path) { return new URL(path, `${baseUrl(env)}/`).toString(); }
export function title(prefix) { return `${prefix} ${Date.now()}`; }

/**
 * أمر FFmpeg لمقطع اصطناعي: ضجيج عالي الإنتروبيا بمعدل ثابت، فالحجم يتبع المعدل لا حشو أصفار.
 * `megabytes` يحدد المعدل المطلوب (مع المدة)؛ والحجم الفعلي يُقاس بعد التوليد ولا يُفترض.
 */
export function ffmpegArgs(output, { seconds = 10, megabytes = 0 } = {}) {
  const video = megabytes ? ["-b:v", `${Math.max(1, Math.round(megabytes * 8 * 1024 * 1024 / seconds / 1000))}k`] : [];
  const rate = video.length ? [...video, "-minrate", video[1], "-maxrate", video[1], "-bufsize", `${parseInt(video[1], 10) * 2}k`] : [];
  return ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${megabytes ? "960x540" : "640x360"}:rate=24${megabytes ? ",noise=alls=100:allf=t+u" : ""}`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ...rate,
    "-c:a", "aac", "-shortest", output];
}

/** حدّ أدنى للحجم الفعلي مقابل المطلوب: أصغر منه لا يعد قياسًا بالحجم المعلن. */
export const SIZE_TOLERANCE = 0.9;

export function syntheticClip(prefix, { seconds = 10, megabytes = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `post-history-${prefix}-`));
  const output = join(dir, `${prefix}.mp4`);
  const r = spawnSync("ffmpeg", ffmpegArgs(output, { seconds, megabytes }), { encoding: "utf8" });
  if (r.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new EnvironmentError(`ffmpeg failed: ${r.stderr || "unknown error"}`); }
  const size = statSync(output).size;
  if (megabytes && size < megabytes * 1024 * 1024 * SIZE_TOLERANCE) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`synthetic clip is ${size} bytes, below ${SIZE_TOLERANCE * 100}% of the requested ${megabytes} MiB`);
  }
  const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
  return { path: output, sha256, size, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function login(page, env, { email, password, locale = "ar" }) {
  await page.goto(url(env, `/${locale}/login`), { waitUntil: "domcontentloaded" });
  await page.getByLabel(/البريد الإلكتروني|Email/i).fill(email);
  await page.getByLabel(/كلمة المرور|Password/i).fill(password);
  const totp = page.getByLabel(/رمز التحقق|TOTP|one-time/i).first();
  if (await totp.count()) await totp.fill(env.ACCEPTANCE_TOTP ?? "");
  await page.getByRole("button", { name: /دخول|Sign in|Login/i }).click();
  await page.waitForURL(/\/((ar|en)\/)?(inbox|store)(?:\?|$)/, { timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
}

/** مسار الرفع في نتيجة القياس لا يخرج عن قيم المخطط: `tusd` للرفع الفعلي، و`n/a` لما لا يرفع. */
export function result(testName, env, extra = {}) {
  return newResult(testName, { device: { platform: "browser", model: "Playwright" }, upload_path: "n/a", ...extra });
}

/**
 * يختم الوثيقة ويكتبها. فشل المخطط لا يُترك للمستدعي: يرجع `{ file: null, error }` فيطبع السكربت الخلل ويخرج بـ 1 بدل أن
 * يرمي من فرع `catch` نفسه.
 */
export function finishAndWrite(doc, argv, slug, resultValue, metrics, notes) {
  finish(doc, resultValue, metrics, notes);
  const args = parseArgs(argv);
  try {
    return { file: args["dry-run"] ? writeResult(doc, { dryRun: true }) : writeResult(doc, { slug }), error: null };
  } catch (error) {
    console.error(`result not written: ${error.message}`);
    return { file: null, error };
  }
}

export function checkList() {
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  return { checks, check };
}
export function envDoc(env, testName, extra = {}) { return result(testName, env, { network: { profile: env.ACCEPTANCE_NETWORK_PROFILE ?? "default" }, ...extra }); }

/** رمز الخروج لخلل بيئة (2، دون نتيجة) أو لفشل مقيس (1). */
export function exitCodeFor(error) { return error instanceof EnvironmentError ? 2 : 1; }
