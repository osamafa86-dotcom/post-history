import { expect, test, type Locator, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function signIn(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });
const box = async (target: Locator) => (await target.boundingBox())!;
const background = (target: Locator) => target.evaluate(node => getComputedStyle(node).backgroundColor);

for (const locale of ["ar", "en"] as const) {
  test(`the orders and refunded line under an organization's purchases reads in the page's direction (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); await signIn(page, "admin", locale); await page.goto(`/${locale}/buyer-organizations`);
    const refunded = page.getByTestId("refunded-part").first(); await expect(refunded).toBeVisible();
    const line = page.getByTestId("purchase-line").filter({ has: page.getByTestId("refunded-part") }).first(), orders = line.getByTestId("orders-part"), amount = refunded.locator("bdi[dir='ltr']");
    await expect(line).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const [o, r, a] = [await box(orders), await box(refunded), await box(amount)];
    // العدّ يُقرأ أولًا ثم جملة المسترد: إلى اليمين في العربية وإلى اليسار في الإنجليزية. والمبلغ في موضعه من جملته كما في قالبها
    // («مسترد {amount}» في آخرها، و"{amount} refunded" في أولها).
    const m = locale === "ar" ? ar : en, amountFirst = m.buyers.refundedPart.startsWith("{amount}"), rtl = locale === "ar";
    if (rtl) expect(o.x).toBeGreaterThanOrEqual(r.x + r.width - 1); else expect(o.x + o.width).toBeLessThanOrEqual(r.x + 1);
    const atReadingStart = rtl ? Math.abs(a.x + a.width - (r.x + r.width)) <= 1 : Math.abs(a.x - r.x) <= 1, atReadingEnd = rtl ? Math.abs(a.x - r.x) <= 1 : Math.abs(a.x + a.width - (r.x + r.width)) <= 1;
    expect(amountFirst ? atReadingStart : atReadingEnd).toBe(true);
    await expect(orders).toHaveText(/\d/); await expect(amount).toHaveText(/\d+\.\d{2}/);
    for (const phone of [390]) {
      await page.setViewportSize({ width: phone, height: 844 }); await expect(line).toBeVisible();
      const [po, pr] = [await box(orders), await box(refunded)];
      if (Math.abs(po.y - pr.y) < 4) { if (locale === "ar") expect(po.x).toBeGreaterThanOrEqual(pr.x + pr.width - 1); else expect(po.x + po.width).toBeLessThanOrEqual(pr.x + 1); }
    }
  });
}

test("my organization counts seats in words, and its primary actions are the store's gold like add to cart", async ({ page }) => {
  await signIn(page, "buyeradmin"); await page.goto("/ar/store/71000000-0000-4000-8000-000000000001");
  await page.getByRole("radio").first().check(); const gold = await background(page.locator(".store-buy button.store"));
  await page.goto("/ar/organization"); const profile = page.getByTestId("organization-profile"); await expect(profile).toBeVisible();
  await expect(profile).toContainText(/\d+ من \d+/); await expect(profile).not.toContainText(/\d+ \/ \d+/);
  const edit = page.getByRole("button", { name: ar.buyers.edit, exact: true }), invite = page.getByRole("button", { name: ar.buyers.invite, exact: true });
  await expect(edit).toHaveClass(/store/); await expect(invite).toHaveClass(/store/);
  expect(await background(edit)).toBe(gold);
});

test("the license certificate speaks to its reader: named values, the type once, a full verification address, a gold download", async ({ page }) => {
  await signIn(page, "buyeradmin"); await page.goto("/ar/store/licenses/93000000-0000-4000-8000-000000000001");
  const certificate = page.getByTestId("certificate"); await expect(certificate).toBeVisible();
  const contents = page.getByTestId("delivery-contents"); await expect(contents).toBeVisible();
  await expect(contents).not.toContainText(/[a-z]+\/[a-z0-9.+-]+/); await expect(contents.locator("li").first()).toContainText(`${ar.store.duration} `); await expect(contents.locator("li").first()).toContainText(`${ar.store.resolution} `);
  // «النوع» مرة واحدة حين يطابق اسم القالب اسم نوعه.
  const type = certificate.locator("dl.metadata div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${ar.licenses.type}$`) }) }).locator("dd");
  const text = (await type.innerText()).trim(), parts = text.split(" · "); expect(new Set(parts).size).toBe(parts.length);
  const verify = page.getByTestId("verify-url"), origin = new URL(page.url()).origin;
  await expect(verify).toHaveText(new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/ar/verify/`)); await expect(verify).toHaveAttribute("href", /^\/ar\/verify\//);
  const download = page.getByRole("button", { name: ar.licenses.download, exact: true });
  if (await download.count()) await expect(download).toHaveClass(/store/);
});

test("the page tells the browser its bar colour for both modes, and controls answer a tap at once", async ({ page }) => {
  await page.goto("/ar/login");
  const metas = await page.locator("meta[name='theme-color']").evaluateAll(nodes => nodes.map(node => [node.getAttribute("media"), node.getAttribute("content")]));
  expect(metas).toEqual([["(prefers-color-scheme: light)", "#FFFFFF"], ["(prefers-color-scheme: dark)", "#121A28"]]);
  expect(await page.locator("meta[name='viewport']").getAttribute("content")).not.toContain("viewport-fit");
  const submit = page.getByRole("button", { name: ar.signIn, exact: true });
  expect(await submit.evaluate(node => getComputedStyle(node).touchAction)).toBe("manipulation");
  expect(await page.getByLabel(ar.email).evaluate(node => getComputedStyle(node).touchAction)).toBe("manipulation");
});
