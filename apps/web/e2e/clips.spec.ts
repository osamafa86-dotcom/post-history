import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
async function login(page: Page, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill("reviewer@example.test"); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page).not.toHaveURL(/login/);
}
const ready = (page: Page) => expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
const count = (text: string, n: number) => text.replace("{n}", String(n)).replace("{total}", "2");
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });
test.afterAll(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("a material with two videos plays each: a clip's thumbnail is a button that moves the player to that clip", async ({ page, request }) => {
  const { id, clips } = await (await request.post(`${api}/__test/two-clips`)).json() as { id: string; clips: string[] };
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await login(page); await page.goto(`/ar/materials/${id}`); await ready(page);
  const counter = page.getByTestId("clip-counter"), buttons = page.getByTestId("clip-button"), source = () => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentSrc);
  await expect(counter).toHaveText(count(ar.clips.counter, 1)); await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "true"); await expect(buttons.nth(1)).toHaveAccessibleName(count(ar.clips.open, 2));
  expect(await source()).toContain(`/files/${clips[0]}/content`);
  await buttons.nth(1).click();
  await expect(counter).toHaveText(count(ar.clips.counter, 2)); await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true"); await expect(buttons.nth(0)).toHaveAttribute("aria-pressed", "false");
  await ready(page); expect(await source()).toContain(`/files/${clips[1]}/content`);
  await expect(page.locator(".shaka-controls-container")).toHaveCount(1); await expect(page.getByTestId("material-player")).toHaveAttribute("data-shape", "portrait");
  // العلامة على مساحة الصورة: الإطار طولي والمقطع عرضي، فالصورة شريط في وسطه والعلامة داخلها لا فوقها.
  await expect.poll(() => page.getByTestId("material-player").evaluate(frame => {
    const video = frame.querySelector("video")!, mark = frame.querySelector(".watermark")!.getBoundingClientRect(), box = frame.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight), top = box.top + (box.height - video.videoHeight * scale) / 2, left = box.left + (box.width - video.videoWidth * scale) / 2;
    return mark.top >= top && mark.bottom <= top + video.videoHeight * scale && mark.left >= left && mark.right <= left + video.videoWidth * scale;
  })).toBe(true);
  // مصغّرات الشريط تحمل الكلمة القصيرة كاملة، لا نصًّا مقصوصًا.
  const short = page.locator(".thumbnails .watermark"); await expect(short).toHaveCount(2); await expect(short.first()).toHaveText(ar.watermarkShort);
  expect(await short.evaluateAll(marks => marks.every(mark => mark.scrollWidth <= mark.clientWidth && mark.getBoundingClientRect().right <= mark.parentElement!.getBoundingClientRect().right))).toBe(true);
  expect(errors).toEqual([]);
});

for (const locale of ["ar", "en"] as const) test(`${locale}: the player asks the browser about the light copy's codecs and names its seek bar`, async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { asked: string[] }; w.asked = [];
    const can = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function (type: string) { return /avc1/.test(type) ? "probably" : can.call(this, type); };
    const info = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
    navigator.mediaCapabilities.decodingInfo = (config: MediaDecodingConfiguration) => { w.asked.push(config.video?.contentType ?? ""); return info(config); };
  });
  const m = locale === "ar" ? ar : en;
  await login(page, locale); await page.locator(".material-link").first().click(); await ready(page);
  const asked = await page.evaluate(() => (window as unknown as { asked: string[] }).asked);
  expect(asked.length).toBeGreaterThan(0); expect(asked.filter(type => !/codecs="[^"]+"/.test(type))).toEqual([]);
  await expect(page.locator(".shaka-seek-bar")).toHaveAttribute("aria-label", m.playerSeek);
});

test("a photo material shows its picture in the player's place and moves between photos", async ({ page, request }) => {
  const { id, photos } = await (await request.post(`${api}/__test/photos`)).json() as { id: string; photos: string[] };
  await login(page); await page.goto(`/ar/materials/${id}`);
  const stage = page.getByTestId("photo-stage"), shown = stage.locator("img"), buttons = page.getByTestId("clip-button"), counter = page.getByTestId("clip-counter");
  await expect(shown).toHaveAttribute("src", new RegExp(`/files/${photos[0]}/content$`)); await expect.poll(() => shown.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  await expect(page.locator("video")).toHaveCount(0); await expect(page.getByTestId("preview-preparing")).toHaveCount(0);
  await expect(counter).toHaveText(count(ar.clips.photoCounter, 1)); await expect(buttons).toHaveCount(2); await expect(buttons.nth(1)).toHaveAccessibleName(count(ar.clips.openPhoto, 2));
  await buttons.nth(1).click();
  await expect(shown).toHaveAttribute("src", new RegExp(`/files/${photos[1]}/content$`)); await expect(counter).toHaveText(count(ar.clips.photoCounter, 2)); await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "true");
  // العلامة الكاملة على الصورة نفسها
  const mark = stage.locator(".watermark"); await expect(mark).toHaveText(ar.watermark);
  expect(await stage.evaluate(element => { const img = element.querySelector("img")!.getBoundingClientRect(), mark = element.querySelector(".watermark")!.getBoundingClientRect(); return mark.top >= img.top && mark.right <= img.right + 1 && mark.left >= img.left; })).toBe(true);
});
