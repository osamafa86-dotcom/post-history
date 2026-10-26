import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newResult, finish, writeResult, parseArgs } from "../lib/measurement.mjs";

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
  throw new Error(`Playwright is unavailable: ${last?.message ?? "install it in the web workspace"}`);
}

export function envMissing(env, keys) { return keys.filter((key) => !env[key]); }
export function baseUrl(env) { return env.ACCEPTANCE_BASE_URL.replace(/\/$/, ""); }
export function url(env, path) { return new URL(path, `${baseUrl(env)}/`).toString(); }
export function title(prefix) { return `${prefix} ${Date.now()}`; }

export function syntheticClip(prefix, { seconds = 10, megabytes = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `post-history-${prefix}-`));
  const output = join(dir, `${prefix}.mp4`);
  const args = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];
  if (megabytes) args.splice(-4, 0, "-b:v", `${Math.ceil(megabytes * 8 / seconds)}M`);
  args.push(output);
  const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (r.status !== 0) { rmSync(dir, { recursive: true, force: true }); throw new Error(`ffmpeg failed: ${r.stderr || "unknown error"}`); }
  const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
  return { path: output, sha256, size: readFileSync(output).length, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function login(page, env, { email, password, locale = "ar" }) {
  await page.goto(url(env, `/${locale}/login`), { waitUntil: "domcontentloaded" });
  await page.getByLabel(/البريد الإلكتروني|Email/i).fill(email);
  await page.getByLabel(/كلمة المرور|Password/i).fill(password);
  const totp = page.getByLabel(/رمز التحقق|TOTP|one-time/i).first();
  if (await totp.count()) await totp.fill(env.ACCEPTANCE_TOTP ?? "");
  await page.getByRole("button", { name: /دخول|Sign in|Login/i }).click();
  await page.waitForURL(/\/((ar|en)\/)?inbox(?:\?|$)/, { timeout: Number(env.ACCEPTANCE_TIMEOUT_MS ?? 30000) });
}

export function result(testName, env, extra = {}) {
  return newResult(testName, { device: { platform: "browser", model: "Playwright" }, upload_path: "web", ...extra });
}
export function finishAndWrite(doc, argv, slug, resultValue, metrics, notes) {
  finish(doc, resultValue, metrics, notes);
  const args = parseArgs(argv);
  return args["dry-run"] ? writeResult(doc, { dryRun: true }) : writeResult(doc, { slug });
}
export function checkList() {
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok, detail }); console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  return { checks, check };
}
export function envDoc(env, testName) { return result(testName, env, { network: { profile: env.ACCEPTANCE_NETWORK_PROFILE ?? "default" } }); }
