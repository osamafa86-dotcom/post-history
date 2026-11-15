import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const b = ar.buyers;
const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the organization admin reissues an invitation code and cancels an invitation; one seats counter follows", async ({ page }) => {
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto("/ar/organization");
  const members = page.getByRole("region", { name: b.members }), counter = members.getByTestId("seats-counter"), rows = members.getByTestId("member-row");
  await expect(counter).toHaveText(fill(b.seatsDetail, { used: 2, active: 2, invited: 0, seats: 3 }));
  // عدّاد واحد: ملف المؤسسة لا يكرر المقاعد لمن يرى قائمة الأعضاء
  await expect(page.getByTestId("organization-profile")).not.toContainText(b.seats); await expect(page.getByTestId("organization-profile")).toContainText("قطر");
  await members.getByLabel(b.inviteEmail).fill("desk@example.test"); await members.getByRole("button", { name: b.invite }).click();
  await expect(members.getByTestId("invite-token")).toHaveText("synthetic-invite-token-member-000000001"); await members.getByRole("button", { name: b.done }).click();
  await expect(counter).toHaveText(fill(b.seatsDetail, { used: 3, active: 2, invited: 1, seats: 3 })); await expect(members.getByText(b.seatsFull)).toBeVisible();
  const invited = rows.filter({ hasText: "desk@example.test" });
  await expect(invited.getByTestId("reissue-invitation")).toHaveText(b.reissue); await expect(invited.getByTestId("cancel-invitation")).toHaveText(b.cancelInvitation);
  // من أكمل القبول لا يحمل الزرّين
  await expect(rows.filter({ hasText: "buyer@example.test" }).getByTestId("reissue-invitation")).toHaveCount(0);

  // إعادة الإصدار: تأكيد يقول أثره، ثم الرمز الجديد مرة واحدة مع أن السابق بطل
  await invited.getByTestId("reissue-invitation").click();
  const reissue = page.getByTestId("confirm-reissue"); await expect(reissue).toContainText("desk@example.test"); await expect(reissue).toContainText(b.reissueEffect.split("{email}")[1].trim());
  await reissue.getByRole("button", { name: b.reissueConfirm }).click();
  await expect(members.getByTestId("invite-token")).toHaveText("synthetic-invite-token-reissued-00000002"); await expect(members.getByTestId("token-replaced")).toHaveText(b.tokenReplaced);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain("synthetic-invite-token");
  await members.getByRole("button", { name: b.done }).click(); await expect(rows).toHaveCount(3);

  // دعوة البريد نفسه من جديد إعادة إصدار لا تعارض، ولا يقفلها امتلاء المقاعد
  const form = members.locator("form.invite-form"); await expect(form.getByRole("button")).toBeDisabled();
  await members.getByLabel(b.inviteEmail).fill("Desk@example.test "); await expect(form.getByRole("button")).toHaveText(b.reissue);
  await form.getByRole("button").click();
  await expect(members.getByTestId("invite-token")).toHaveText("synthetic-invite-token-reissued-00000002"); await expect(members.getByTestId("token-replaced")).toBeVisible();
  await members.getByRole("button", { name: b.done }).click(); await expect(rows).toHaveCount(3);

  // الإلغاء: يخرج من القائمة ويتحرر مقعده
  await invited.getByTestId("cancel-invitation").click();
  const cancel = page.getByTestId("confirm-cancel"); await expect(cancel).toContainText("desk@example.test");
  await cancel.getByRole("button", { name: b.cancelConfirm }).click();
  await expect(rows).toHaveCount(2); await expect(counter).toHaveText(fill(b.seatsDetail, { used: 2, active: 2, invited: 0, seats: 3 }));
  await expect(members.getByRole("button", { name: b.invite })).toBeEnabled(); await expect(members.getByText(b.seatsFull)).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
});

test("an invitation accepted or cancelled elsewhere says so and refreshes the list, without the server's words", async ({ page }) => {
  await login(page, "buyeradmin"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto("/ar/organization");
  const members = page.getByRole("region", { name: b.members });
  await members.getByLabel(b.inviteEmail).fill("desk@example.test"); await members.getByRole("button", { name: b.invite }).click(); await members.getByRole("button", { name: b.done }).click();
  // في جلسة أخرى أُلغيت الدعوة: الصف ما زال ظاهرًا هنا
  const elsewhere = await page.evaluate(async () => {
    const headers = { "X-Requested-With": "post-history-web" }, base = "/api/bff/buyer-organizations/90000000-0000-4000-8000-000000000001/members";
    const list = await (await fetch(base, { headers })).json() as { items: { user_id: string; status: string }[] };
    return (await fetch(`${base}/${list.items.find(m => m.status === "invited")!.user_id}/invitation`, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: "{}" })).status;
  });
  expect(elsewhere).toBe(204);
  await members.getByTestId("member-row").filter({ hasText: "desk@example.test" }).getByTestId("reissue-invitation").click();
  await page.getByTestId("confirm-reissue").getByRole("button", { name: b.reissueConfirm }).click();
  await expect(members.getByTestId("invitation-gone")).toHaveText(b.invitationGone); await expect(page.getByTestId("confirm-reissue")).toHaveCount(0);
  await expect(members.getByTestId("member-row")).toHaveCount(2); await expect(members.getByTestId("invite-token")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("never-display-canary");
});

test("the system admin picks the country by name, is warned about a repeated legal name, and reads one seats figure", async ({ page }) => {
  await login(page, "admin", "en"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  const e = en.buyers; await page.getByRole("link", { name: e.nav }).click();
  const row = page.getByTestId("organization-row").filter({ hasText: "News Network" });
  await expect(row.getByTestId("organization-country")).toHaveText("Qatar"); await expect(row.getByTestId("seats-pair")).toHaveText(fill(e.seatsPair, { active: 2, seats: 3 }));
  await page.getByRole("button", { name: e.new }).click();
  const country = page.getByTestId("organization-country-select");
  await expect(country.locator("option", { hasText: "Jordan" })).toHaveCount(1); expect(await country.locator("option").count()).toBe(250);
  await expect(page.getByTestId("duplicate-legal-name")).toHaveCount(0);
  await page.getByLabel(e.legalName).fill("  شبكة الأخبار الاصطناعية ذ.م.م ");
  await expect(page.getByTestId("duplicate-legal-name")).toHaveText(fill(e.duplicateLegalName, { name: "شبكة الأخبار الاصطناعية ذ.م.م" }));
  await page.getByLabel(e.legalName).fill("Synthetic Press LLC"); await expect(page.getByTestId("duplicate-legal-name")).toHaveCount(0);
  // المدعو الأول يظهر في مقاعد المؤسسة الجديدة بتفصيله
  const name = page.getByRole("group", { name: e.displayName }); await name.getByLabel(en.templates.arabic).fill("صحافة اصطناعية"); await name.getByLabel(en.templates.english).fill("Synthetic Press");
  await country.selectOption("JO"); await page.getByLabel(e.billingEmail).fill("billing@press.example.test"); await page.getByLabel(e.firstAdmin).fill("admin@press.example.test");
  await page.getByRole("button", { name: e.create }).click(); await page.getByRole("button", { name: e.done }).click();
  const created = page.getByTestId("organization-row").filter({ hasText: "Synthetic Press" });
  await expect(created.getByTestId("organization-country")).toHaveText("Jordan"); await expect(created.getByTestId("seats-pair")).toHaveText(fill(e.seatsPair, { active: 1, seats: 5 }));
  await expect(created.getByTestId("seats-split")).toHaveText(fill(e.seatsSplit, { active: 0, invited: 1 }));
  await created.getByRole("button", { name: e.open }).click();
  await expect(page.getByRole("region", { name: e.members }).getByTestId("seats-counter")).toHaveText(fill(e.seatsDetail, { used: 1, active: 0, invited: 1, seats: 5 }));
  await expect(page.getByRole("region", { name: e.members }).getByTestId("reissue-invitation")).toBeVisible();
});

test("role-fitting words: a member reads «my orders», and an invoice trails back to its order", async ({ page }) => {
  await login(page, "buyer"); await expect(page).toHaveURL(/\/ar\/store$/); await page.goto("/ar/store/orders");
  await expect(page.getByTestId("orders-lead")).toHaveText(ar.orders.memberLead);
  await page.goto("/ar/store/orders/92000000-0000-4000-8000-000000000001/invoice");
  const trail = page.getByRole("navigation", { name: ar.store.item.breadcrumb });
  await expect(trail.getByRole("link", { name: ar.store.nav.orders })).toHaveAttribute("href", "/ar/store/orders");
  await expect(trail.getByTestId("invoice-order-crumb")).toHaveAttribute("href", "/ar/store/orders/92000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("invoice-country")).toHaveText("قطر");
});
