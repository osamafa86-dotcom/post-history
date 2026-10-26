import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";

// Domain suffixes a bare hostname is recognised by. A closed list, not "any dotted word": `page.goto`, `error.message` and `web-e2e.mjs`
// must survive, and file extensions (`ts`, `md`, `sh`, `zip`, `mov`) are deliberately absent. A hostname with an explicit port is scrubbed whatever its suffix.
const HOST_SUFFIXES = "com|net|org|io|dev|app|co|uk|de|fr|eu|info|biz|xyz|cloud|ai|me|tv|us|ca|au|in|ps|sa|ae|tr|local|localhost|internal|lan|test|example|invalid|corp|home|arpa|edu|gov";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Removes what a result file or the terminal must not carry: the base URL, any host or origin, IPv4 addresses and long hex runs (hashes, tokens, ids).
 * Paths, file names, short words and everything else stay, so the failure is still readable. Pure and idempotent.
 */
export function scrub(text, { base = process.env.ACCEPTANCE_BASE_URL } = {}) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  let origin = null, host = null;
  try { const u = new URL(base); origin = u.origin; host = u.host; } catch { /* no usable base */ }
  if (origin) out = out.replace(new RegExp(escapeRegExp(origin), "gi"), "<base>");
  if (host) out = out.replace(new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?![\\w-])`, "gi"), "<base>");
  // scheme://host[:port] or scheme://[ipv6]:port; the path after it stays
  out = out.replace(/\bhttps?:\/\/(?:\[[0-9a-f:.]+\](?::\d{1,5})?|[^\s/"'`<>()\]\\?#]+)/gi, "<host>");
  out = out.replace(/(?<![\w.-])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w-])/g, "<ip>");
  out = out.replace(new RegExp(`(?<![\\w./@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${HOST_SUFFIXES})(?::\\d{1,5})?(?![\\w-]|\\.\\w)`, "gi"), "<host>");
  out = out.replace(/(?<![\w./@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}:\d{1,5}(?![\w-])/gi, "<host>");
  out = out.replace(/(?<![\w-])localhost(?::\d{1,5})?(?![\w-])/gi, "<host>");
  out = out.replace(/(?<![0-9a-zA-Z])(?=[0-9a-f]*[a-f])[0-9a-f]{16,}(?![0-9a-zA-Z])/gi, "<hash>");
  return out;
}

/** غياب المتصفح أو متغيرات البيئة خلل بيئة لا فشل مقيس: يخرج بالرمز 2 ولا يكتب نتيجة. الرسالة تُنقّى عند الإنشاء فلا تحمل مضيفًا. */
export class EnvironmentError extends Error {
  name = "EnvironmentError";
  constructor(message, options) { super(scrub(String(message ?? "")), options); }
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
  // every free-text string that reaches the result passes scrub(): the notes (which carry the checks' evidence) and string metrics
  const cleanMetrics = metrics && Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, typeof v === "string" ? scrub(v) : v]));
  finish(doc, resultValue, cleanMetrics, scrub(notes));
  const args = parseArgs(argv);
  try {
    return { file: args["dry-run"] ? writeResult(doc, { dryRun: true }) : writeResult(doc, { slug }), error: null };
  } catch (error) {
    console.error(`result not written: ${scrub(error.message)}`);
    return { file: null, error };
  }
}

export function checkList() {
  const checks = [];
  const check = (name, ok, detail = "") => {
    const clean = scrub(String(detail));
    checks.push({ name, ok, detail: clean });
    console.log(`${ok ? "ok" : "FAIL"} ${scrub(name)}${clean ? ` — ${clean}` : ""}`);
  };
  return { checks, check };
}
export function envDoc(env, testName, extra = {}) { return result(testName, env, { network: { profile: env.ACCEPTANCE_NETWORK_PROFILE ?? "default" }, ...extra }); }

/** رمز الخروج لخلل بيئة (2، دون نتيجة) أو لفشل مقيس (1). */
export function exitCodeFor(error) { return error instanceof EnvironmentError ? 2 : 1; }
