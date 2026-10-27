import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
async function login(page: Page, email: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill(email); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("editor in chief browses the bilingual catalog, opens an item with a watermarked preview and picks a license", async ({ page }) => {
  const outgoing: string[] = []; page.on("request", r => outgoing.push(r.url()));
  await login(page, "chief@example.test");
  await page.getByRole("link", { name: ar.store.title }).click();
  await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  await page.getByLabel(ar.store.search).fill("1"); await page.getByRole("button", { name: ar.store.browse.searchButton, exact: true }).click();
  await expect(page.getByTestId("catalog-card")).toHaveCount(1);
  await expect(page.getByTestId("catalog-card")).toContainText("150.00");
  await page.getByRole("link", { name: "لقطات اصطناعية 1" }).first().click();
  await expect(page.getByRole("heading", { name: "لقطات اصطناعية 1" })).toBeVisible();
  await expect(page.locator(".viewer-mark")).toHaveText("fixture@example.test");
  await expect.poll(() => page.locator(".store-preview video").evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await page.locator(".store-preview video").getAttribute("src")).toMatch(/^\/api\/bff\/catalog\/[\w-]+\/preview$/);
  await page.getByRole("radio", { name: /حصري 48 ساعة/ }).check();
  await expect(page.getByRole("radio", { name: /حصري 48 ساعة/ })).toBeChecked();
  await expect(page.getByTestId("item-facts")).toContainText("3840×2160"); await expect(page.getByTestId("item-facts")).not.toContainText("13:45");
  await expect(page.locator("main")).not.toContainText("لقطة عامة"); await expect(page.getByTestId("buyer-preview")).toBeVisible();
  const body = await page.locator("body").textContent(); expect(body).not.toContain("never-display-canary");
  const raw = await page.request.get("/api/bff/catalog"); expect(await raw.text()).not.toMatch(/never-display-canary|31\.5|"gps"|"lat"/);
  expect(outgoing.every(url => url.startsWith("http://127.0.0.1:3100/"))).toBe(true);
});

test("exclusivity that is taken cannot be chosen, in English too", async ({ page }) => {
  await login(page, "chief@example.test", "en");
  await page.goto("/en/store/71000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("heading", { name: "Synthetic footage 2" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("radio", { name: /Exclusive 48 h/ })).toBeDisabled();
  await expect(page.getByText(en.store.exclusiveUntil.split("{date}")[0], { exact: false })).toBeVisible();
});

test("reporters do not see the catalog and the BFF refuses them", async ({ page }) => {
  await login(page, "reporter@example.test");
  await expect(page.getByRole("link", { name: ar.store.title })).toHaveCount(0);
  expect((await page.request.get("/api/bff/catalog")).status()).toBe(403);
  await page.goto("/ar/store"); await expect(page.getByText(ar.store.denied)).toBeVisible();
});
