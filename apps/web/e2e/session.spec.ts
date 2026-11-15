import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

const api = "http://127.0.0.1:3201", first = "20000000-0000-4000-8000-000000000001";
async function fill(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
}
async function signIn(page: Page, role = "reviewer", locale: "ar" | "en" = "ar") { await page.goto(`/${locale}/login`); await fill(page, role, locale); await page.waitForURL(url => !url.pathname.endsWith("/login")); }
/** ما يفعله المتصفح عند تبديل التبويب: الحالة ثم الحدث. المتصفح بلا واجهة لا يبدّل تبويبًا فعلًا. */
const tab = (page: Page, state: "hidden" | "visible") => page.evaluate(value => { Object.defineProperty(document, "visibilityState", { value, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, state);
const menu = (page: Page, m = ar) => page.getByRole("button", { name: new RegExp(m.shell.account) });
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("switching to another tab and back keeps what the user was doing", async ({ page }) => {
  await signIn(page); await expect(page.getByTestId("material-row")).toHaveCount(50);
  // الوارد: تبويب مختار وبحث مكتوب
  await page.getByRole("navigation", { name: ar.inboxTabs.label }).getByRole("button", { name: new RegExp(`^${ar.inboxTabs.urgent}`) }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(40);
  await page.locator("#shell-search").fill("1"); await expect(page.getByTestId("material-row")).not.toHaveCount(40);
  const rows = await page.getByTestId("material-row").count(); expect(rows).toBeGreaterThan(0);
  await tab(page, "hidden"); await expect(page.getByTestId("material-row")).toHaveCount(rows);
  const checked = page.waitForResponse(response => response.url().endsWith("/api/bff/auth/me")); await tab(page, "visible"); expect((await checked).status()).toBe(200);
  await expect(page.locator("#shell-search")).toHaveValue("1"); await expect(page.getByTestId("material-row")).toHaveCount(rows);
  await expect(page.getByRole("navigation", { name: ar.inboxTabs.label }).getByRole("button", { name: new RegExp(`^${ar.inboxTabs.urgent}`) })).toHaveAttribute("aria-pressed", "true");
  // صفحة المادة: حوار التحويل وسببه المكتوب
  await page.goto(`/ar/materials/${first}`); await page.getByRole("button", { name: ar.review.open, exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("radio", { name: ar.states.editorial_state.rejected }).check();
  await dialog.getByLabel(ar.review.reason, { exact: true }).fill("سبب كُتب قبل تبديل التبويب");
  await tab(page, "hidden"); const again = page.waitForResponse(response => response.url().endsWith("/api/bff/auth/me")); await tab(page, "visible"); await again;
  await expect(dialog).toBeVisible(); await expect(dialog.getByLabel(ar.review.reason, { exact: true })).toHaveValue("سبب كُتب قبل تبديل التبويب");
  await expect(dialog.getByRole("radio", { name: ar.states.editorial_state.rejected })).toBeChecked();
});

test("a hidden tab does not poll, and polls at once when it is shown", async ({ page }) => {
  await signIn(page); await expect(page.getByTestId("material-row")).toHaveCount(50);
  let snapshots = 0; page.on("request", request => { if (request.url().endsWith("/api/bff/dashboard/newsroom")) snapshots++; });
  await tab(page, "hidden"); await page.waitForTimeout(700); const before = snapshots;
  // اللقطة تُستطلع كل خمس ثوانٍ في تبويب ظاهر
  await page.waitForTimeout(6500); expect(snapshots).toBe(before);
  await tab(page, "visible"); await expect.poll(() => snapshots, { timeout: 3000 }).toBeGreaterThan(before);
});

test("a session revoked while the tab was hidden is cleared when the tab is shown, and signing in returns to the page", async ({ page, request }) => {
  await signIn(page); await page.goto("/ar/board"); await expect(page.getByRole("heading", { level: 1, name: ar.board.title })).toBeVisible();
  await tab(page, "hidden"); await request.post(`${api}/__test/revoke`); await tab(page, "visible");
  await expect(page).toHaveURL(/\/ar\/login\?reason=revoked&next=%2Far%2Fboard$/); await expect(page.getByText(ar.revoked, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: ar.board.title })).toHaveCount(0);
  await fill(page, "reviewer"); await expect(page).toHaveURL(/\/ar\/board$/); await expect(page.getByRole("heading", { level: 1, name: ar.board.title })).toBeVisible();
});

test("a visitor with no session sees the sign-in page without a revocation notice, and a deep link opens after signing in", async ({ page }) => {
  await page.goto("/"); await expect(page).toHaveURL(/\/ar\/login$/); await expect(page.getByText(ar.revoked)).toHaveCount(0); await expect(page.getByText(ar.signedOut)).toHaveCount(0);
  await fill(page, "reporter"); await expect(page).toHaveURL(/\/ar\/my-materials$/);
  await menu(page).click(); await page.getByRole("button", { name: ar.logout, exact: true }).click();
  // الخارج باختياره لا يُعاد إلى صفحته
  await expect(page).toHaveURL(/\/ar\/login\?reason=signed-out$/); await expect(page.getByText(ar.signedOut, { exact: true })).toBeVisible();
  await page.goto(`/en/materials/${first}`); await expect(page).toHaveURL(new RegExp(`/en/login\\?next=%2Fen%2Fmaterials%2F${first}$`)); await expect(page.getByText(en.revoked)).toHaveCount(0);
  // لغة صفحة الدخول تُحفظ معها صفحة العودة، والداخل يعود بلغته المختارة
  await page.getByRole("link", { name: en.language, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/ar/login\\?next=%2Fen%2Fmaterials%2F${first}$`));
  await fill(page, "reviewer"); await expect(page).toHaveURL(new RegExp(`/ar/materials/${first}$`)); await expect(page.getByRole("heading", { name: ar.shell.material.nextStep, exact: true })).toBeVisible();
});

test("the return page is a page of this application only", async ({ page }) => {
  for (const next of ["https://untrusted.example.test/ar/inbox", "//untrusted.example.test/ar/inbox", "/ar/login", "/api/bff/auth/me", "/ar/unknown"]) {
    await page.goto(`/ar/login?next=${encodeURIComponent(next)}`); await fill(page, "reviewer"); await expect(page).toHaveURL(/\/ar\/inbox$/);
    await menu(page).click(); await page.getByRole("button", { name: ar.logout, exact: true }).click(); await expect(page).toHaveURL(/reason=signed-out$/);
  }
});

test("signing out in one tab signs the other out with the same words", async ({ page, context }) => {
  await signIn(page); const other = await context.newPage(); await other.goto("/ar/board"); await expect(other.getByRole("heading", { level: 1, name: ar.board.title })).toBeVisible();
  await menu(page).click(); await page.getByRole("button", { name: ar.logout, exact: true }).click(); await expect(page).toHaveURL(/reason=signed-out$/);
  await expect(other).toHaveURL(/\/ar\/login\?reason=signed-out$/); await expect(other.getByText(ar.signedOut, { exact: true })).toBeVisible(); await expect(other.getByText(ar.revoked)).toHaveCount(0);
});

for (const locale of ["ar", "en"] as const) {
  test(`sign-in says when the reason is the rate limit or the server, not the credentials (${locale})`, async ({ page, request }) => {
    const m = locale === "ar" ? ar : en;
    await request.post(`${api}/__test/login-throttle?seconds=37`);
    await page.goto(`/${locale}/login`); await fill(page, "reviewer", locale);
    await expect(page.locator("form [role=alert]")).toHaveText(m.loginThrottled.replace("{wait}", locale === "ar" ? "37 ثانية" : "37 seconds")); await expect(page).toHaveURL(new RegExp(`/${locale}/login$`));
    await page.route("**/api/bff/auth/login", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "temporarily_unavailable" }) }));
    await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.locator("form [role=alert]")).toHaveText(m.loginUnavailable);
    await page.unroute("**/api/bff/auth/login");
    await page.getByLabel(m.password, { exact: true }).fill("a-wrong-password"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.locator("form [role=alert]")).toHaveText(m.loginFailed);
    await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${locale}/inbox$`));
  });
}

test("the account menu names the account by its work name", async ({ page }) => {
  await signIn(page, "named"); await menu(page).click();
  await expect(page.getByTestId("topbar-user")).toHaveText(`مشرفة المناوبة · ${ar.topbar.roles.supervisor}`);
});

test("linking the authenticator warns before leaving, and an unfinished setup is explained instead of a role refusal", async ({ page }) => {
  await page.goto("/ar/invite#token=synthetic-invite-token-session-0001");
  const leaving = () => page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
  expect(await leaving()).toBe(false);
  await page.getByLabel(ar.store.invite.newPassword, { exact: true }).fill("a-new-synthetic-pass"); await page.getByLabel(ar.store.invite.repeatPassword, { exact: true }).fill("a-new-synthetic-pass");
  await page.getByRole("button", { name: ar.store.invite.submit }).click();
  await expect(page.getByRole("heading", { level: 1, name: ar.store.invite.totpTitle })).toBeVisible();
  await expect(page.getByTestId("keep-open")).toContainText(ar.store.invite.keepOpen); expect(await leaving()).toBe(true);
  // غادر قبل التأكيد: الجلسة المقيّدة تفتح صفحة تقول الحال والخطوة التالية، لا «خارج صلاحيات دورك»
  await page.goto("/ar/store");
  const state = page.getByTestId("reset-incomplete"); await expect(state).toContainText(ar.resetIncomplete.title); await expect(state).toContainText(ar.resetIncomplete.next);
  await expect(page.getByTestId("no-access")).toHaveCount(0); await expect(page.getByText(ar.shell.noAccess.title)).toHaveCount(0);
  await state.getByRole("button", { name: ar.logout }).click(); await expect(page).toHaveURL(/\/ar\/login\?reason=signed-out$/);
});
