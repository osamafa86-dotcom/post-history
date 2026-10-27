import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const s = ar.store, b = ar.store.browse, o = ar.orders, l = ar.licenses;
async function login(page: Page, role: string) {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: ar.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("catalog: trust strip, instant filters, removable filter chips and cards without identifiers", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await expect(page.getByRole("list", { name: b.trustLabel }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  await expect(page.getByTestId("catalog-card").first()).toContainText(b.verified); await expect(page.getByTestId("catalog-card").first()).toContainText(b.exclusive);
  await expect(page.getByTestId("catalog-card").nth(1)).not.toContainText(b.exclusive);
  const filtered = page.waitForRequest(r => r.url().includes("/api/bff/catalog?") && r.url().includes("min_height=1080"));
  await page.getByLabel(s.resolution).selectOption("1080"); await filtered;
  await page.getByLabel(s.search).fill("zzz"); await page.getByRole("button", { name: b.searchButton, exact: true }).click();
  await expect(page.getByText(s.empty)).toBeVisible();
  await page.getByRole("button", { name: b.removeFilter.replace("{filter}", "«zzz»") }).click();
  await expect(page.getByTestId("catalog-card")).toHaveCount(2);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.screenshot({ path: ".artifacts/buyer-catalog-ar.png", fullPage: true });
});

test("item: authenticity card without fingerprints, no shot list, hold note and a priced add-to-cart", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  const card = page.getByRole("region", { name: b.authenticity });
  await expect(card).toContainText(b.verifiedOriginal); await expect(card).toContainText(b.version.replace("{n}", "1")); await expect(card).toContainText("فلسطين بوست");
  await expect(page.locator("main")).not.toContainText(/لقطة عامة|sha256|never-display-canary/);
  expect(await (await page.request.get("/api/bff/catalog/71000000-0000-4000-8000-000000000001")).text()).not.toContain("لقطة عامة");
  await page.getByRole("radio", { name: /حصري 48 ساعة/ }).check(); await expect(page.getByText(b.holdNote)).toBeVisible();
  await page.getByRole("button", { name: b.addFor.replace("{price}", "") }).click();
  await expect(page.getByRole("status").filter({ hasText: b.added })).toBeVisible();
  await page.getByRole("link", { name: s.inCart }).click();
  await expect(page.getByTestId("cart-line")).toHaveCount(1); await expect(page.getByText(b.filesAfterPayment)).toBeVisible();
  await expect(page.getByTestId("cart-line").getByRole("link", { name: b.changeLicense })).toHaveAttribute("href", "/ar/store/71000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: o.place }).click();
  await expect(page.getByRole("status").filter({ hasText: o.sandboxTitle })).toBeVisible();
  await expect(page.getByTestId("hold-timer")).toContainText(/حجز الحصرية ينتهي خلال \d\d:\d\d/);
  await page.screenshot({ path: ".artifacts/buyer-checkout-ar.png", fullPage: true });
});

test("licences: cards with a verification link; the public page shows number and status only, signed out", async ({ page, context }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/);
  await page.goto("/ar/store/licenses");
  const active = page.getByTestId("license-row").filter({ hasText: "PH-2026-7K3M9Q2XRT" });
  await expect(active.locator(".badge")).toHaveText(l.statuses.active);
  await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000002");
  await expect(page.locator("main").getByRole("alert")).toContainText(l.reasons.refunded);
  await context.clearCookies();
  await page.goto("/en/verify/PH-2026-7K3M9Q2XRT");
  const verification = page.getByTestId("verification");
  await expect(page.getByTestId("verification-status")).toHaveText(en.licenses.statuses.active);
  await expect(verification).toContainText("PH-2026-7K3M9Q2XRT"); await expect(verification).not.toContainText(/canary|Synthetic|worldwide/i);
  const raw = await (await page.request.get("/api/bff/license-verifications/PH-2026-7K3M9Q2XRT")).json();
  expect(Object.keys(raw).sort()).toEqual(["license_number", "status"]);
  await page.goto("/ar/verify/PH-2026-0000000000"); await expect(page.locator("main").getByRole("alert")).toHaveText(l.verify.notFound);
  await page.goto("/ar/verify/not-a-number"); await expect(page.locator("main").getByRole("alert")).toHaveText(l.verify.notFound);
});

test("ADR 0035 buyer sees proof days and offer terms, with null proof and dated exclusivity", async ({ page }) => {
  await login(page, "buyer"); await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  const card = page.getByRole("region", { name: b.authenticity });
  await expect(card).toContainText(b.verifiedOn.split("{date}")[0]); await expect(card).toContainText(b.approvedOn.split("{date}")[0]); await expect(card).not.toContainText(/\d{1,2}:\d{2}/);
  const terms = page.locator(".offer-terms").first(); await terms.locator("summary").click(); await expect(terms).toContainText("استخدام اصطناعي قبل الشراء"); await expect(terms).toContainText(ar.templates.worldwide);
  await page.goto("/ar/store/71000000-0000-4000-8000-000000000002");
  await expect(page.getByRole("region", { name: b.authenticity })).not.toContainText(b.verifiedOn.split("{date}")[0]);
  await expect(page.locator(".license-picker")).toContainText(s.exclusiveUntil.split("{date}")[0]);
  await expect(page.locator("main")).not.toContainText(/work_name|actor_name|sha256|never-display-canary/);
});

test("ADR 0035 license exposes delivery specifications and size only when supplied", async ({ page }) => {
  await login(page, "buyer"); await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("delivery-contents")).toContainText("video/mp4"); await expect(page.getByTestId("delivery-contents")).toContainText("1920×1080"); await expect(page.getByTestId("delivery-size")).toBeVisible();
  await page.route("**/api/bff/licenses/93000000-0000-4000-8000-000000000001", async route => { const response = await route.fetch(), data = await response.json(); delete data.delivery_contents; data.delivery_size_bytes = null; await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.getByTestId("certificate")).toBeVisible(); await expect(page.getByTestId("delivery-contents")).toHaveCount(0); await expect(page.getByTestId("delivery-size")).toHaveCount(0);
});
