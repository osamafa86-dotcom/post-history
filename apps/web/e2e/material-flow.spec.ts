import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };

const api = "http://127.0.0.1:3201", first = "20000000-0000-4000-8000-000000000001", r = ar.review;
async function signIn(page: Page, role = "reviewer") {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click(); await page.waitForURL(url => !url.pathname.endsWith("/login"));
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("the history tells staff who moved the material and why, and names the reader's own steps", async ({ page, request }) => {
  await request.post(`${api}/__test/request-changes`);
  await signIn(page); await page.goto(`/ar/materials/${first}`);
  const history = page.locator(".history-list"); await expect(history.locator("li")).toHaveCount(2);
  await expect(history).toContainText("اطّلعت عليها والمصدر قيد التحقق"); await expect(history).toContainText("أعد اللقطة الافتتاحية بإضاءة أفضل");
  // المنفّذ بلا اسم عمل: «حساب <أول 8>» لا وصف مبهم
  await expect(history.locator("li").first()).toContainText(ar.admin.unnamed.replace("{id}", "10000000")); await expect(history).not.toContainText(ar.material.neutralActor);
  // صاحب المادة يعيد إرسالها بسببه: سطره «أنت» وسببه ظاهر له، وسبب «اطّلعت» الداخلي لا يصله
  await page.context().clearCookies(); await signIn(page, "reporter"); await page.goto(`/ar/materials/${first}`);
  // صاحب المادة بلا دور مكتب يعيدها من شريطه أعلى الصفحة (لا بطاقة «الخطوة التالية» بلغة الطاقم)
  await page.getByTestId("owner-changes").getByRole("button", { name: ar.owner.resubmit }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByLabel(ar.owner.whatChanged).fill("أعدت تصوير اللقطة الافتتاحية"); await dialog.getByRole("button", { name: ar.owner.send }).click();
  await expect(history.locator("li")).toHaveCount(3); await expect(history.locator("li").first()).toContainText("أعدت تصوير اللقطة الافتتاحية"); await expect(history.locator("li").first()).toContainText(ar.material.actorYou);
  await expect(history).toContainText("أعد اللقطة الافتتاحية بإضاءة أفضل"); await expect(history).not.toContainText("اطّلعت عليها والمصدر قيد التحقق");
  await expect(history).not.toContainText(ar.admin.unnamed.replace("{id}", "10000000"));
});

test("a conflict keeps the dialog and the written reason when the target is still available", async ({ page, request }) => {
  await signIn(page); await page.goto(`/ar/materials/${first}`); await page.getByRole("button", { name: r.open, exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("radio", { name: ar.states.editorial_state.rejected }).check();
  await dialog.getByLabel(r.reason, { exact: true }).fill("سبب كُتب قبل أن تتغيّر المادة"); await expect(dialog.locator(".length-counter")).toHaveText("29/2000");
  await request.post(`${api}/__test/bump`);
  const send = dialog.locator("button:not([type=button])"); await send.click(); await send.click();
  await expect(dialog.getByText(r.changed)).toBeVisible(); await dialog.getByRole("button", { name: r.reloadChanges, exact: true }).click();
  await expect(dialog).toBeVisible(); await expect(dialog.getByLabel(r.reason, { exact: true })).toHaveValue("سبب كُتب قبل أن تتغيّر المادة");
  await expect(dialog.getByRole("radio", { name: ar.states.editorial_state.rejected })).toBeChecked(); await expect(dialog.getByText(r.changed)).toHaveCount(0);
  // والإرسال بعد التحميل يمرّ
  await send.click(); await send.click(); await expect(dialog).toHaveCount(0); await expect(page.locator(".history-list")).toContainText("سبب كُتب قبل أن تتغيّر المادة");
});

test("publishing a sensitive material asks for an explicit confirmation that names its flags", async ({ page, request }) => {
  await request.post(`${api}/__test/final-sensitive`);
  await signIn(page, "chief"); await page.goto(`/ar/materials/${first}`);
  await expect(page.getByTestId("sensitivity-line")).toContainText(ar.shell.material.sensitiveRule); expect(ar.shell.material.sensitiveRule).not.toContain("لا تُنشر");
  await page.getByRole("button", { name: r.open, exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: ar.states.editorial_state.published }).check(); await dialog.getByLabel(r.reason, { exact: true }).fill("اعتُمدت للنشر");
  const warning = dialog.getByTestId("sensitive-publish"); await expect(warning).toContainText(ar.upload.injured);
  await expect(dialog.getByTestId("publish-no-produced")).toHaveText(r.publishNoProduced);
  const send = dialog.locator("button:not([type=button])"); await expect(send).toBeDisabled();
  await warning.getByRole("checkbox").check(); await expect(send).toBeEnabled();
  // هدف آخر لا يحتاج التأكيد، والعودة إلى النشر تطلبه من جديد
  await dialog.getByRole("radio", { name: ar.states.editorial_state.in_production }).check(); await expect(warning).toHaveCount(0);
  await dialog.getByRole("radio", { name: ar.states.editorial_state.published }).check(); await expect(send).toBeDisabled();
  await warning.getByRole("checkbox").check(); await send.click(); await expect(dialog).toHaveCount(0);
  // من لا يحرّر المساهمين يقرؤهم نصًّا
  await expect(page.getByTestId("contributor-list")).toBeVisible(); await expect(page.getByTestId("contributor-row")).toHaveCount(0);
});

test("an escalation tells who cannot receive what to do, and the urgent alert is for those who can receive", async ({ page, request }) => {
  await request.post(`${api}/__test/notices?for=chief`);
  await signIn(page, "chief"); await expect(page.getByTestId("material-row").first()).toBeVisible(); await expect(page.getByTestId("urgent-alert")).toHaveCount(0);
  await page.goto("/ar/notifications"); await page.getByTestId("notification").filter({ hasText: ar.shell.bell.kinds.escalated }).click();
  await expect(page.getByTestId("escalated-help")).toHaveText(ar.notice.escalatedHelp);
  await page.context().clearCookies(); await signIn(page); await expect(page.getByTestId("urgent-alert")).toBeVisible();
  await page.goto("/ar/notifications"); await page.getByTestId("notification").first().click(); await expect(page.getByTestId("escalated-help")).toHaveCount(0);
});

test("a delivered task says what comes next, and the montage card says it was delivered", async ({ page, request }) => {
  await request.post(`${api}/__test/assignments`); await signIn(page);
  await page.goto("/ar/tasks"); await page.getByTestId("task-card").nth(1).getByRole("link", { name: ar.tasks.open }).click();
  const actions = page.getByTestId("task-actions");
  await actions.getByRole("button", { name: ar.task.act.acknowledged }).click(); await actions.getByRole("button", { name: ar.task.act.in_progress }).click();
  await expect(actions.getByTestId("task-next")).toContainText(ar.task.next.working);
  await actions.getByRole("button", { name: ar.task.act.done }).click(); await page.getByTestId("confirm-done").getByRole("button", { name: ar.task.act.done }).click();
  await expect(actions.getByTestId("task-next")).toContainText(ar.task.next.delivered);
  await actions.getByTestId("task-next").getByRole("link", { name: ar.task.openMaterial }).click(); await expect(page).toHaveURL(/\/ar\/materials\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("assignment-none")).toContainText(ar.assign.cardDone.split("{name}")[1].trim()); await expect(page.getByTestId("assignment-card")).not.toContainText(ar.assign.cardNone);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("each cell of a rule card carries its column's name", async ({ page }) => {
    await signIn(page, "admin"); await page.goto("/ar/notification-rules");
    const levels = page.getByTestId("default-row").first().locator("td").nth(1);
    await expect(levels).toHaveAttribute("data-label", ar.rules.defaults.audience);
    expect(await levels.evaluate(node => getComputedStyle(node, "::before").content)).toContain(ar.rules.defaults.audience);
  });
});
