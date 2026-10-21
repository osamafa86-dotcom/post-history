import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
async function login(page: Page, email: string) {
  await page.goto("/ar/login");
  await page.getByLabel(ar.email).fill(email); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("admin creates a rule with escalation, edits it with the current revision and deletes it", async ({ page, request }) => {
  await login(page, "admin@example.test");
  await page.getByRole("link", { name: ar.rules.title }).click();
  await expect(page.getByText(ar.rules.empty)).toBeVisible();
  await page.getByRole("button", { name: ar.rules.new }).click();
  await page.getByLabel(ar.rules.name).fill("عاجل غزة");
  await page.getByLabel(ar.rules.assignment).check();
  await page.getByRole("button", { name: ar.rules.addStep }).click(); await page.getByRole("button", { name: ar.rules.addStep }).click();
  await expect(page.getByTestId("escalation-step")).toHaveCount(2);
  await page.getByRole("button", { name: ar.rules.save }).click();
  await expect(page.getByTestId("rule-row")).toHaveCount(1);
  await expect(page.getByTestId("rule-row")).toContainText(ar.rules.events["material.urgent_received"]);
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  const created = (await (await request.get(`${api}/__test/state`)).json()).writes.find((w: { path: string }) => w.path === "/v1/notification-rules");
  expect(created.body.escalation.map((s: { level: number; after_seconds: number }) => [s.level, s.after_seconds])).toEqual([[1, 600], [2, 1200]]);

  // تعديل بمراجعة قديمة: 412 ولا يُكتب شيء، ثم إعادة الفتح بالمراجعة الحالية.
  await page.getByRole("button", { name: ar.rules.edit }).click();
  await expect(page.getByLabel(ar.rules.name)).toHaveValue("عاجل غزة");
  await request.post(`${api}/__test/bump-rule`);
  await page.getByLabel(ar.rules.name).fill("عاجل غزة والضفة");
  await page.getByRole("button", { name: ar.rules.save }).click();
  await expect(page.getByText(ar.review.changed)).toBeVisible();
  await page.getByRole("button", { name: ar.rules.cancel, exact: true }).click();
  await page.getByRole("button", { name: ar.rules.edit }).click();
  await page.getByLabel(ar.rules.name).fill("عاجل غزة والضفة");
  await page.getByRole("button", { name: ar.rules.save }).click();
  await expect(page.getByTestId("rule-row")).toContainText("عاجل غزة والضفة");

  await page.getByRole("button", { name: ar.rules.delete }).click();
  await page.getByRole("dialog").getByRole("button", { name: ar.rules.delete }).click();
  await expect(page.getByText(ar.rules.empty)).toBeVisible();
});

test("an incomplete rule is not sent", async ({ page, request }) => {
  await login(page, "admin@example.test");
  await page.goto("/ar/notification-rules");
  await page.getByRole("button", { name: ar.rules.new }).click();
  await page.getByLabel(ar.rules.name).fill("بلا مستلم");
  await page.getByRole("group", { name: ar.rules.roles }).getByLabel(ar.rules.roleNames.supervisor).uncheck();
  await page.getByRole("button", { name: ar.rules.save }).click();
  await expect(page.getByText(ar.rules.invalid)).toBeVisible();
  expect((await (await request.get(`${api}/__test/state`)).json()).writes).toHaveLength(0);
});

test("editor in chief reads rules without editing; other roles are refused", async ({ page }) => {
  await login(page, "chief@example.test");
  await page.getByRole("link", { name: ar.rules.title }).click();
  await expect(page.getByText(ar.rules.readOnly)).toBeVisible();
  await expect(page.getByRole("button", { name: ar.rules.new })).toHaveCount(0);
  const write = await page.request.post("/api/bff/notification-rules", { headers: { Origin: "http://127.0.0.1:3100", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID() }, data: {} });
  expect(write.status()).toBe(403);
});
