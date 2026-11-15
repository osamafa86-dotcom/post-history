import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import ar from "../messages/ar.json" with { type: "json" };
const api = "http://127.0.0.1:3201", first = "20000000-0000-4000-8000-000000000001";
async function login(page: Page, role = "reporter") {
  await page.goto("/ar/login"); await page.getByLabel(ar.email).fill(`${role}@example.test`); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page).not.toHaveURL(/login/);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); await request.post(`${api}/__test/request-changes`); });
test.afterAll(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("the reporter's way back from a material is «my materials», the locale root leads to the role's start page, and the staff inbox is not theirs", async ({ page, browser }) => {
  await login(page);
  await page.goto(`/ar/materials/${first}`);
  const back = page.locator("nav.breadcrumb a");
  await expect(back).toHaveText(ar.mine.nav); await expect(back).toHaveAttribute("aria-label", ar.mine.back);
  await back.click(); await expect(page).toHaveURL(/\/ar\/my-materials$/);
  await page.goto("/ar"); await expect(page).toHaveURL(/\/ar\/my-materials$/);
  await page.goto("/ar/inbox");
  await expect(page.getByTestId("no-access")).toContainText(ar.shell.inbox.deniedReporter); await expect(page.locator(".inbox-row, [data-testid='inbox-row']")).toHaveCount(0);
  // موظف المكتب يعود إلى الوارد كما كان
  const staff = await (await browser.newContext({ baseURL: new URL(page.url()).origin })).newPage(); await login(staff, "reviewer");
  await staff.goto(`/ar/materials/${first}`); await expect(staff.locator("nav.breadcrumb a")).toHaveText(ar.inbox);
  await staff.goto("/ar"); await expect(staff).toHaveURL(/\/ar\/inbox$/); await staff.context().close();
});

test("signed out, the locale root opens the sign-in page with no «session revoked» notice", async ({ page }) => {
  await page.goto("/ar"); await expect(page).toHaveURL(/\/ar\/login$/);
  await expect(page.getByText(ar.revoked, { exact: true })).toHaveCount(0);
});

test("a change request sits at the top of the owner's page with the note, and one field sends the material back", async ({ page }) => {
  await login(page); await page.goto(`/ar/materials/${first}`);
  const notice = page.getByTestId("owner-changes");
  await expect(notice.getByRole("heading", { name: ar.owner.changesTitle })).toBeVisible();
  await expect(notice.getByTestId("owner-note")).toContainText("أعد اللقطة الافتتاحية بإضاءة أفضل"); await expect(notice.getByTestId("owner-note")).toContainText("00:42");
  // لا بطاقات الطاقم: لا «الخطوة التالية» ولا نموذج المساهمين
  await expect(page.getByRole("heading", { name: ar.shell.material.nextStep })).toHaveCount(0); await expect(page.getByTestId("contributor-row")).toHaveCount(0);
  await notice.getByRole("button", { name: ar.owner.resubmit }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("heading", { name: ar.owner.resubmit })).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(0); await expect(dialog).not.toContainText(ar.review.pinTime);
  const send = dialog.getByRole("button", { name: ar.owner.send });
  await dialog.getByLabel(ar.owner.whatChanged).fill("abc"); await expect(dialog.getByText(ar.owner.minChars)).toBeVisible(); await expect(send).toBeDisabled();
  await dialog.getByLabel(ar.owner.whatChanged).fill("أعدت تصوير اللقطة الافتتاحية"); await expect(dialog.getByText(ar.owner.minChars)).toHaveCount(0);
  await send.click();
  await expect(page.locator(".toast")).toContainText(ar.states.editorial_state.reviewing);
  await expect(page.locator("[data-track='editorial_state']")).toContainText(ar.states.editorial_state.reviewing);
  await expect(page.getByTestId("owner-changes")).toHaveCount(0);
});

test("the owner corrects the title and place before acceptance, and only what changed is sent", async ({ page, request }) => {
  await login(page); await page.goto(`/ar/materials/${first}`);
  await page.getByTestId("owner-changes").getByRole("button", { name: ar.owner.edit }).click();
  const dialog = page.getByRole("dialog"), save = dialog.getByRole("button", { name: ar.owner.save });
  await expect(save).toBeDisabled();
  await dialog.getByLabel(ar.upload.titleLabel).fill("abcd"); await save.click();
  await expect(dialog.getByLabel(ar.upload.titleLabel)).toHaveAttribute("aria-invalid", "true"); await expect(dialog.getByText(ar.upload.errors.title)).toBeVisible();
  await dialog.getByLabel(ar.upload.titleLabel).fill("عنوان مصحّح بعد طلب التعديل"); await dialog.getByLabel(ar.upload.city).fill("خان يونس");
  await save.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("عنوان مصحّح بعد طلب التعديل"); await expect(page.locator(".material-meta")).toContainText("خان يونس");
  const { writes } = await (await request.get(`${api}/__test/state`)).json() as { writes: { path: string; method: string; body: Record<string, unknown> }[] };
  const patch = writes.filter(w => w.method === "PATCH"); expect(patch).toHaveLength(1);
  expect(patch[0].body).toEqual({ title: "عنوان مصحّح بعد طلب التعديل", city: "خان يونس" });
});

test("a material whose file never arrived is completed from its own page, with no second material", async ({ page, request }) => {
  const { id } = await (await request.post(`${api}/__test/no-file`)).json() as { id: string };
  await login(page);
  const action = page.getByTestId("mine-action").filter({ hasText: ar.mine.awaitingFile }); await expect(action).toHaveCount(1);
  await expect(page.getByTestId("mine-kpis").locator(".kpi")).toHaveCount(4); await expect(page.getByTestId("mine-kpis").locator("[data-kpi='rejected'] strong")).toHaveText("1");
  await action.getByRole("link").click(); await expect(page).toHaveURL(new RegExp(`/ar/materials/${id}$`));
  await expect(page.getByTestId("preview-preparing")).toContainText(ar.previewNoFile); await expect(page.getByTestId("preview-preparing")).not.toContainText(ar.previewPreparing);
  const upload = page.getByTestId("owner-upload"); await expect(upload.getByRole("heading", { name: ar.owner.noFileTitle })).toBeVisible();
  await page.getByTestId("owner-file").setInputFiles({ name: "A010C001.MOV", mimeType: "video/quicktime", buffer: randomBytes(1048576 + 77) });
  await expect(page.locator("[data-track='technical_state']")).toContainText(ar.states.technical_state.verified, { timeout: 20000 });
  await expect(page.getByTestId("owner-upload")).toHaveCount(0);
  const sessions = await (await request.get(`${api}/__test/uploads`)).json() as { state: string }[];
  expect(sessions.map(s => s.state)).toEqual(["verified"]);
  const { writes } = await (await request.get(`${api}/__test/state`)).json() as { writes: { path: string; method: string }[] };
  expect(writes.filter(w => w.path === "/v1/materials" && w.method === "POST")).toHaveLength(0);
});

test("a failed upload is retried from the material's own page: the track returns to pending and the same material takes the file", async ({ page, request }) => {
  const failed = "20000000-0000-4000-8000-000000000003";
  await login(page); await page.goto(`/ar/materials/${failed}`);
  const upload = page.getByTestId("owner-upload"); await expect(upload.getByRole("heading", { name: ar.owner.failedTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: ar.shell.material.nextStep })).toHaveCount(0);
  await page.getByTestId("owner-file").setInputFiles({ name: "A011C002.MOV", mimeType: "video/quicktime", buffer: randomBytes(1048576 + 91) });
  await expect(page.locator("[data-track='technical_state']")).toContainText(ar.states.technical_state.verified, { timeout: 20000 });
  await expect(page.getByTestId("owner-upload")).toHaveCount(0);
  const { writes } = await (await request.get(`${api}/__test/state`)).json() as { writes: { path: string; method: string; body: Record<string, unknown> }[] };
  expect(writes.filter(w => w.path.endsWith("/transitions")).map(w => w.body)).toEqual([{ track: "technical", to: "pending", reason: ar.owner.retryReason }]);
  expect(writes.filter(w => w.path === "/v1/materials" && w.method === "POST")).toHaveLength(0);
});
