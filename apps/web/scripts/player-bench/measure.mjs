import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { platform, release } from "node:os";
import { serve } from "./serve.mjs";

if (process.env.WEB_PLAYER_BENCH !== "1") throw new Error("Set WEB_PLAYER_BENCH=1");
const requireBench = createRequire(resolve(".artifacts/player-deps/package.json"));
const { chromium, webkit, expect } = requireBench("@playwright/test");
const started = new Date(), output = resolve(".artifacts/player-result");
await mkdir(output, { recursive: true });
const server = await serve();
const executablePath = process.env.WEB_PLAYER_EXECUTABLE;
const engine = process.env.WEB_PLAYER_BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const metrics = { ...server.sizes, browser_version: browser.version(),
  browser_distribution: executablePath?.includes("chrome-headless-shell") ? "Chrome Headless Shell" : process.env.WEB_PLAYER_BROWSER ?? "Playwright Chromium",
  playwright_version: requireBench("@playwright/test/package.json").version,
  shaka_version: requireBench("shaka-player/package.json").version,
  videojs_version: JSON.parse(await readFile(".artifacts/player-deps/node_modules/@videojs/react/package.json", "utf8")).version,
  temporary_lock_sha256: createHash("sha256").update(await readFile(".artifacts/player-deps/package-lock.json")).digest("hex"),
  ffmpeg_version: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
  safari_measured: false, real_material_hls_measured: false,
};
const checks = [];
try {
  for (const fixture of ["vfr-offset", "hdr-hlg"]) for (const player of ["videojs", "shaka"]) for (const locale of ["ar", "en"]) {
    const id = `${player}_${fixture.replaceAll("-", "_")}_${locale}`;
    const context = await browser.newContext({ viewport: { width: 1120, height: 800 } });
    const page = await context.newPage(); page.setDefaultTimeout(5000);
    let external = 0, pageErrors = 0, httpErrors = 0;
    page.on("request", request => { if (!request.url().startsWith(server.origin + "/") && !request.url().startsWith("blob:")) external++; });
    page.on("pageerror", () => pageErrors++);
    page.on("response", response => { if (response.status() >= 400) httpErrors++; });
    await page.addInitScript(() => {
      window.benchCspCount = 0;
      document.addEventListener("securitypolicyviolation", () => window.benchCspCount++);
    });
    const check = async (name, operation) => {
      try { await operation(); checks.push({ id, name, pass: true }); metrics[`${id}_${name}`] = true; }
      catch (error) { console.log(id, name, String(error.message).split("\n")[0]); checks.push({ id, name, pass: false }); metrics[`${id}_${name}`] = false; }
    };
    await page.goto(`${server.origin}/${player}?fixture=${fixture}&locale=${locale}`);
    const video = page.locator("video");
    const play = page.locator(player === "shaka" ? ".shaka-play-button" : ".media-play-button").last();
    await check("hls", async () => {
      await expect.poll(() => video.evaluate(v => v.readyState), { timeout: 20000 }).toBeGreaterThanOrEqual(2);
      await expect.poll(() => video.evaluate(v => v.duration)).toBeGreaterThan(10);
      await video.evaluate(v => v.play());
      await expect.poll(() => video.evaluate(v => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
      await video.evaluate(v => v.pause());
    });
    await check("space_play_pause", async () => {
      await play.focus(); await play.press("Space"); await expect.poll(() => video.evaluate(v => v.paused)).toBe(false);
      await play.press("Space"); await expect.poll(() => video.evaluate(v => v.paused)).toBe(true);
    });
    await video.evaluate(v => { v.pause(); v.currentTime = 5; });
    await check("captions", async () => {
      if (player === "shaka") await expect(page.locator(".shaka-text-container")).toContainText("Reuters");
      else {
        const captions = page.locator(".media-captions-button"); await captions.click();
        await expect.poll(() => video.evaluate(v => Array.from(v.textTracks).some(t => t.mode === "showing" && Array.from(t.activeCues ?? []).some(c => c.text?.includes("Reuters"))))).toBe(true);
      }
    });
    if (player === "shaka") await check("mixed_rtl_order", async () => {
      const text = page.locator(".shaka-text-container"); await expect(text).toContainText("Reuters");
      await expect.poll(() => text.evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
        while ((node = walker.nextNode())) {
          const value = node.textContent ?? "", a = value.indexOf("وصل"), r = value.indexOf("Reuters"), n = value.indexOf("10:30");
          if (a < 0 || r < 0 || n < 0) continue;
          const x = i => { const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1); return range.getBoundingClientRect().x; };
          return x(a) > x(r) && x(n) < x(n + 4) && getComputedStyle(node.parentElement).unicodeBidi === "plaintext";
        }
        return false;
      })).toBe(true);
    });
    await check("thumbnail", async () => {
      const seek = page.locator(player === "shaka" ? ".shaka-seek-bar" : "[role=slider]").first();
      const box = await seek.boundingBox(); if (!box) throw new Error("No seek bar");
      const image = page.locator(player === "shaka" ? ".shaka-player-ui-thumbnail-image" : ".media-slider-thumbnail-image").first();
      const hover = async position => { await page.mouse.move(box.x + box.width * position, box.y + box.height / 2); };
      await hover(.3);
      await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBe(1600);
      const first = await image.getAttribute("style");
      await hover(.7);
      await expect.poll(() => image.getAttribute("style")).not.toBe(first);
      await expect(image).toBeVisible();
    });
    await page.screenshot({ path: join(output, `${id}.png`) });
    await check("arrow_seek", async () => {
      await video.evaluate(v => { v.pause(); v.currentTime = 5; }); await play.focus(); await play.press("ArrowRight");
      await expect.poll(() => video.evaluate(v => v.currentTime)).toBeGreaterThan(5);
      await play.press("ArrowLeft"); await expect.poll(() => video.evaluate(v => v.currentTime)).toBeLessThan(7);
    });
    await check("keyboard_volume", async () => {
      const muted = await video.evaluate(v => v.muted);
      if (muted) { const unmute = page.getByRole("button", { name: locale === "ar" ? player === "shaka" ? "إعادة الصوت" : "إلغاء كتم الصوت" : "Unmute", exact: true }); await unmute.focus(); await unmute.press("Space"); }
      const slider = page.locator(player === "shaka" ? ".shaka-volume-bar" : ".media-volume-slider-thumb").last();
      await slider.focus(); const before = await video.evaluate(v => v.volume); await slider.press("ArrowDown");
      await expect.poll(() => video.evaluate(v => v.volume)).toBeLessThan(before);
      await slider.press("ArrowUp"); await expect.poll(() => video.evaluate(v => v.volume)).toBeGreaterThanOrEqual(before - .01);
    });
    await check("tab_navigation", async () => {
      await page.locator("#outside").focus(); await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("#player"))).toBe(true);
    });
    await check("outside_keys", async () => {
      await video.evaluate(v => v.pause()); await page.locator("#outside").fill("x"); await page.locator("#outside").press("Space");
      expect(await video.evaluate(v => v.paused)).toBe(true); await expect(page.locator("#outside")).toHaveValue("x ");
    });
    await check("fullscreen", async () => {
      const name = locale === "ar" ? "ملء الشاشة" : player === "shaka" ? "Full screen" : "Enter fullscreen";
      const full = page.getByRole("button", { name, exact: true }); await full.focus(); await full.press("Enter");
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true); await page.evaluate(() => document.exitFullscreen());
    });
    if (player === "shaka") await check("multiline_captions", async () => {
      // انتظر انتهاء seek وإشارة WebVTT المطلوبة بدل قراءة DOM للإشارة السابقة.
      await video.evaluate(async v => { v.pause(); await new Promise(resolve => { v.addEventListener("seeked", resolve, { once: true }); v.currentTime = 9; }); });
      await expect(page.locator(".shaka-text-container")).toContainText("وسطر ثانٍ", { timeout: 7000 });
      await expect.poll(() => page.locator(".shaka-text-container").evaluate(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), lines = []; let node;
        while ((node = walker.nextNode())) {
          const value = node.textContent ?? "";
          if (!value.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) if (rect.width > 0) lines.push(rect.y);
        }
        return new Set(lines.map(y => Math.round(y))).size >= 2;
      }), { timeout: 7000 }).toBe(true);
      await page.mouse.move(0, 0); await page.screenshot({ path: join(output, `${id}-multiline.png`) });
    });
    metrics[`${id}_external_requests`] = external; metrics[`${id}_page_errors`] = pageErrors;
    metrics[`${id}_http_errors`] = httpErrors; metrics[`${id}_csp_violations`] = await page.evaluate(() => window.benchCspCount);
    await context.close();
    console.log(id, checks.filter(c => c.id === id && !c.pass).map(c => c.name));
  }
} finally { await browser.close(); await server.close(); }
const chosenFailed = checks.some(c => c.id.startsWith("shaka_") && !c.pass) || Object.entries(metrics).some(([k, v]) => k.startsWith("shaka_") && /_(external_requests|page_errors|http_errors|csp_violations)$/.test(k) && v !== 0);
const measurement = { schema_version: 1, tool: "web", role: "web", test_name: "player-choice", decision_ref: 6,
  started_at: started.toISOString(), ended_at: new Date().toISOString(), result: chosenFailed ? "fail" : "partial",
  device: { platform: "browser", model: "Headless synthetic-fixture benchmark", os_version: `${platform()} ${release()}` },
  network: { profile: "loopback" }, upload_path: "n/a", metrics,
  notes: "عينتا العامل #212 دون تعديل HLS/VTT؛ FFmpeg المحلي موثق في metrics وليس صورة العامل 8.0.1. قياس Linux headless لا يثبت Safari فعليًا أو جهازًا تفاعليًا. تكامل MP4 عبر BFF له اختبارات منفصلة. HLS للمواد الحقيقية ينتظر عقد تفويض أعضاء الحزمة، لذلك النجاح المحلي يبقى partial. أحجام gzip للمنصة المعزولة وليست زيادة Next.js؛ Video.js يتضمن React في المنصة. لقطات الصور اصطناعية فقط." };
await writeFile(join(output, "measurement.json"), JSON.stringify(measurement, null, 2) + "\n");
await writeFile(join(output, "checks.json"), JSON.stringify(checks, null, 2) + "\n");
if (chosenFailed) process.exitCode = 1;
