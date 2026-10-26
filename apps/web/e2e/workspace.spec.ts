import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
async function login(page: Page, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill("fixture@example.test"); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test("Arabic RTL inbox, independent states, explicit filters, pagination and detail", async ({ page }) => {
  const outgoing: string[] = []; page.on("request", r => outgoing.push(r.url()));
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  for (const track of ["technical_state", "editorial_state", "rights_state"]) await expect(page.locator(`[data-track='${track}']`)).toHaveCount(50);
  const payload = await page.request.get("/api/bff/materials"); expect(await payload.text()).not.toContain("never-display-canary");
  await page.getByRole("button", { name: ar.next, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await expect(page.locator("tbody")).toContainText("100");
  await page.getByText(ar.filters, { exact: true }).click(); await page.getByLabel(ar.governorate, { exact: true }).fill("غزة"); await page.getByRole("button", { name: ar.apply }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50); await expect(page.locator("tbody")).not.toContainText("القدس");
  await page.locator(".material-link").first().click(); await expect(page.getByRole("heading", { name: ar.details, exact: true })).toBeVisible();
  await expect(page.locator("video")).toBeVisible();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  await page.locator("video").evaluate((v: HTMLVideoElement) => { v.muted = true; return v.play(); });
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);
  await expect.poll(() => page.getByAltText(ar.thumbnail).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
  await expect(page.locator(".watermark")).toHaveCount(2); expect(await page.title()).not.toContain("مادة اختبار");
  expect(outgoing.every(url => url.startsWith("http://127.0.0.1:3100/") || url.startsWith("http://localhost:3100/"))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.screenshot({ path: ".artifacts/material-desktop.png", fullPage: true });
});
test("expired storage grants recover through a fresh authenticated derivative request", async ({ page, request }) => {
  await request.post("http://127.0.0.1:3201/__test/expire-media"); await login(page);
  await page.locator(".material-link").first().click();
  await expect.poll(() => page.locator("video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  const source = new URL((await page.locator("video").getAttribute("src"))!);
  expect(source.origin).toBe("http://127.0.0.1:3100"); expect(source.pathname).toMatch(/^\/api\/bff\/materials\/[\w-]+\/files\/[\w-]+\/content$/); expect(source.search + source.hash).toBe("");
  await expect(page.getByText(ar.previewUnavailable)).toHaveCount(0);
});
test("English layout and shared dynamic form screen validate without saving", async ({ page }) => {
  await login(page, "en"); await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("link", { name: en.formPreview, exact: true }).click();
  await page.getByRole("button", { name: en.validate, exact: true }).click(); await expect(page.getByText(en.formInvalid, { exact: true })).toBeVisible();
  await expect(page.locator("[aria-invalid='true']").first()).toBeVisible();
  await expect(page.getByRole("textbox").first()).toBeVisible();
});
test("revocation clears the screen and shows the sign-in reason", async ({ page, request }) => {
  await login(page); await request.post("http://127.0.0.1:3201/__test/revoke");
  await page.getByRole("button", { name: ar.refresh, exact: true }).click();
  await expect(page).toHaveURL(/\/ar\/login\?reason=revoked/); await expect(page.getByText(ar.revoked, { exact: true })).toBeVisible(); await expect(page.getByTestId("material-row")).toHaveCount(0);
  expect((await page.context().cookies()).find(c => c.name === "ph-session")).toBeUndefined();
});
test("all-device logout requires explicit confirmation and clears the HttpOnly session", async ({ page }) => {
  await login(page); const cookies = await page.context().cookies(); expect(cookies.find(c => c.name === "ph-session")?.httpOnly).toBe(true);
  await page.getByRole("button", { name: ar.logoutAll, exact: true }).click(); await expect(page.getByRole("dialog")).toContainText(ar.logoutAllWarning);
  await page.getByRole("button", { name: ar.cancel, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.getByRole("button", { name: ar.logoutAll, exact: true }).click();
  const logout = page.waitForResponse(r => r.url().endsWith("/api/bff/auth/logout"));
  await page.getByRole("button", { name: ar.confirm, exact: true }).click();
  expect((await logout).status()).toBe(200); await expect(page).toHaveURL(/reason=signed-out/);
});
test("small viewport keeps navigation usable and the table scrolls within its panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await expect(page.getByRole("heading", { name: ar.inbox, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("signing out clears another open tab and history cannot restore its private rows", async ({ page, context }) => {
  await login(page); const other = await context.newPage(); await other.goto("/ar/inbox"); await expect(other.getByTestId("material-row")).toHaveCount(50);
  await page.getByRole("button", { name: ar.logout, exact: true }).click(); await expect(page).toHaveURL(/reason=signed-out/);
  await expect(other).toHaveURL(/\/ar\/login/); await expect(other.getByTestId("material-row")).toHaveCount(0);
  await other.goBack(); await expect(other.getByTestId("material-row")).toHaveCount(0);
});
