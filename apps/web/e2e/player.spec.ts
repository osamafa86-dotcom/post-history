import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function openPlayer(page: Page, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill("fixture@example.test");
  await page.getByLabel(m.password, { exact: true }).fill("synthetic-password");
  await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await page.locator(".material-link").first().click();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".shaka-controls-container")).toHaveCount(1);
}

for (const locale of ["ar", "en"] as const) test(`${locale}: local controls, keyboard and fullscreen watermark`, async ({ page }) => {
  const outgoing: string[] = [], errors: string[] = [];
  page.on("request", r => outgoing.push(r.url())); page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { cspCount: number }; w.cspCount = 0;
    document.addEventListener("securitypolicyviolation", () => w.cspCount++);
  });
  await openPlayer(page, locale);
  await expect(page.locator(".shaka-seek-bar")).toHaveCSS("border-top-width", "0px");
  const play = page.locator(".shaka-play-button");
  await expect(play).toHaveAttribute("aria-label", locale === "ar" ? "التشغيل" : "Play");
  await play.focus(); await play.press("Space");
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await play.press("Space"); await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  await page.locator("video").evaluate((v: HTMLVideoElement) => { v.currentTime = 0; });
  await play.press("ArrowRight"); await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);
  const mute = page.locator(".shaka-mute-button");
  const before = await page.locator("video").evaluate((v: HTMLVideoElement) => v.muted);
  await mute.focus(); await mute.press("Space"); await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.muted)).toBe(!before);
  const fullscreen = page.locator(".shaka-fullscreen-button"); await fullscreen.focus(); await fullscreen.press("Enter");
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("material-player"))).toBe(true);
  await expect(page.getByTestId("material-player").locator(".watermark")).toBeVisible();
  await page.evaluate(() => document.exitFullscreen());
  await page.screenshot({ path: `.artifacts/player-${locale}.png`, fullPage: true });
  expect(outgoing.every(url => url.startsWith("http://127.0.0.1:3100/"))).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { cspCount: number }).cspCount)).toBe(0);
  expect(errors).toEqual([]);
});

test("navigation destroys playback and does not duplicate controls on return", async ({ page }) => {
  await openPlayer(page);
  await page.locator("video").evaluate((v: HTMLVideoElement) => { (window as unknown as { oldVideo: HTMLVideoElement }).oldVideo = v; v.muted = true; return v.play(); });
  await page.getByRole("link", { name: ar.inbox, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => { const v = (window as unknown as { oldVideo: HTMLVideoElement }).oldVideo; return !v.isConnected && v.paused && !v.getAttribute("src"); })).toBe(true);
  await page.locator(".material-link").first().click(); await expect(page.locator(".shaka-controls-container")).toHaveCount(1);
});

test("media errors revalidate revoked sessions", async ({ page, request }) => {
  await openPlayer(page); await request.post("http://127.0.0.1:3201/__test/revoke");
  await page.locator("video").evaluate(v => v.dispatchEvent(new Event("error")));
  await expect(page).toHaveURL(/\/ar\/login\?reason=revoked/); await expect(page.locator("video")).toHaveCount(0);
});

test("persistent media errors retry once and show a generic message", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/bff/materials/*/files/*/content", async route => { if (route.request().resourceType() === "image") { await route.continue(); return; } requests++; await route.fulfill({ status: 503, body: "private-media-canary" }); });
  await page.goto("/ar/login");
  await page.getByLabel(ar.email).fill("fixture@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click(); await page.locator(".material-link").first().click();
  await expect(page.getByText(ar.previewUnavailable, { exact: true })).toBeVisible();
  expect(requests).toBe(2); await expect(page.locator("body")).not.toContainText("private-media-canary");
});
