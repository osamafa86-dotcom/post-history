import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };

const api = "http://127.0.0.1:3201", first = "20000000-0000-4000-8000-000000000001", k = ar.shell.bell.kinds;
async function signIn(page: Page, role = "reviewer") {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
const rows = (page: Page) => page.getByTestId("notification");
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("a reporter reads what happened to each material, urgent beside the word, and is asked for no acknowledgement", async ({ page, request }) => {
  await request.post(`${api}/__test/notices?for=reporter`);
  await signIn(page, "reporter"); await expect(page.getByTestId("bell-count")).toHaveText("6");
  await page.goto("/ar/notifications"); await expect(rows(page)).toHaveCount(6);
  for (const word of [k.changes, k.rejected, k.accepted, k.received, k.seen, k.published]) await expect(rows(page).filter({ hasText: word })).toHaveCount(1);
  const urgent = rows(page).filter({ hasText: k.changes }); await expect(urgent.getByTestId("notice-urgent")).toHaveText(ar.states.priority.urgent);
  await expect(rows(page).getByTestId("notice-urgent")).toHaveCount(1);
  // لا قسم «يحتاج إقرارًا» ولا زر إقرار لصاحب المادة
  await expect(page.getByRole("heading", { name: ar.notice.sections.needsAck, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: ar.notice.ack, exact: true })).toHaveCount(0);
  await expect(rows(page).first().getByRole("button", { name: ar.notice.read, exact: true })).toBeVisible();
  // العنوان من المادة نفسها، لا من التنبيه
  await expect(urgent.getByTestId("notice-title")).toHaveText(/\S/); await expect(page.locator("body")).not.toContainText("never-display-canary");
  // لوحة الجرس بالكلمات نفسها
  await page.getByRole("button", { name: new RegExp(`^${ar.shell.bell.open}`) }).click();
  const panel = page.getByTestId("notifications-panel"); await expect(panel.getByTestId("bell-item")).toHaveCount(6); await expect(panel.getByTestId("bell-item").filter({ hasText: k.rejected })).toHaveCount(1);
  await panel.getByRole("button", { name: ar.shell.bell.readAll, exact: true }).click(); await page.keyboard.press("Escape");
  await expect(page.getByTestId("bell-count")).toHaveCount(0);
});

test("staff see an arriving material as an arrival with its title, and only what they may read", async ({ page, request }) => {
  await request.post(`${api}/__test/notices?for=staff`);
  await signIn(page); await expect(page.getByTestId("bell-count")).toHaveText("4");
  await page.goto("/ar/notifications"); await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).filter({ hasText: k.incoming })).toHaveCount(3); await expect(rows(page).filter({ hasText: k.task })).toHaveCount(0); await expect(rows(page).filter({ hasText: k.resubmitted })).toHaveCount(1);
  // العاجل الوارد مهمة تُقرّ: في قسمها وبزرّها
  await expect(page.getByRole("heading", { name: ar.notice.sections.needsAck, exact: true })).toBeVisible();
  await expect(rows(page).first().getByTestId("notice-urgent")).toBeVisible(); await expect(rows(page).first().getByRole("button", { name: ar.notice.ack, exact: true })).toBeVisible();
  // ثلاثة عناوين لثلاث مواد يقرؤها المتصل؛ والرابعة التي لا يقرؤها بكلمتها وحدها
  await expect(page.getByTestId("notice-title")).toHaveCount(3); await expect(page.locator("body")).not.toContainText("never-display-canary");
});

test("the link of a recovery request says so", async ({ page, request }) => {
  await request.post(`${api}/__test/recovery-notice`);
  await signIn(page, "admin"); await page.goto("/ar/notifications");
  await rows(page).filter({ hasText: k.account }).click();
  await expect(page.getByRole("link", { name: ar.notice.openRequest, exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: ar.notice.open, exact: true })).toHaveCount(0);
});

test("the transition dialog shows what reaches the reporter only when the reason does", async ({ page }) => {
  await signIn(page); await page.goto(`/ar/materials/${first}`); await page.getByRole("button", { name: ar.review.open, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: ar.states.editorial_state.rejected }).check(); await dialog.getByLabel(ar.review.reason, { exact: true }).fill("سبب يصل المراسل");
  await expect(dialog.getByTestId("reason-reaches")).toContainText("سبب يصل المراسل"); await expect(dialog.getByTestId("reason-stays")).toHaveCount(0);
  await expect(dialog.getByLabel(ar.review.pinTime)).toBeVisible();
  await dialog.getByRole("radio", { name: ar.states.editorial_state.acknowledged }).check();
  await expect(dialog.getByTestId("reason-stays")).toHaveText(ar.review.reasonStays); await expect(dialog.getByTestId("reason-reaches")).toHaveCount(0);
  // مسار الحقوق: لا يُشعِر المراسل، ولا ثانية مشغّل تُثبَّت عليه
  await dialog.getByLabel(ar.review.track, { exact: true }).selectOption("rights"); await dialog.getByRole("radio").first().check();
  await expect(dialog.getByTestId("reason-stays")).toBeVisible(); await expect(dialog.getByTestId("reason-reaches")).toHaveCount(0); await expect(dialog.getByLabel(ar.review.pinTime)).toHaveCount(0);
});

test("the rules page shows the default routing, warns that a rule replaces it, and marks what is not active yet", async ({ page }) => {
  await signIn(page, "admin"); await page.goto("/ar/notification-rules");
  const table = page.getByTestId("default-routing"); await expect(table.getByTestId("default-row")).toHaveCount(11);
  await expect(table.getByTestId("default-row").filter({ hasText: ar.rules.defaults.events["material.rejected"] })).toContainText(ar.rules.defaults.audiences.reporter);
  await page.getByRole("button", { name: ar.rules.new, exact: true }).click();
  const warning = page.getByTestId("replaces-default"); await expect(warning).toContainText(ar.rules.events["material.urgent_received"]); await expect(warning).toContainText(ar.rules.defaults.audiences.supervisors);
  await page.locator(".rule-form select").first().selectOption("material.updated"); await expect(warning).toHaveCount(0);
  for (const channel of ["web_push", "email", "telegram", "whatsapp", "sms"]) await expect(page.locator(`.rule-form input[name=channels][value=${channel}]`)).toBeDisabled();
  for (const channel of ["in_app", "websocket", "apns", "fcm"]) await expect(page.locator(`.rule-form input[name=channels][value=${channel}]`)).toBeEnabled();
  await expect(page.locator(".rule-form").getByTestId("not-yet")).toHaveCount(6); await expect(page.locator(".rule-form input[type=number]").nth(1)).toBeDisabled();
});
