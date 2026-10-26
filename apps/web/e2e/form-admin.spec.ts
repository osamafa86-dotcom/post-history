import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

async function login(page: Page, role = "admin", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50); await page.goto(`/${locale}/forms`);
  if (["admin", "chief"].includes(role)) await expect(page.getByRole("combobox", { name: m.formsAdmin.version, exact: true })).toHaveValue("1");
}
async function publish(page: Page, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en, t = m.formsAdmin;
  await page.getByRole("button", { name: t.preview, exact: true }).click();
  await page.getByRole("button", { name: t.publish, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: m.confirm, exact: true }).click();
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("publishes a searchable field after preview and preserves the original version", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await login(page); const t = ar.formsAdmin;
  await page.getByRole("button", { name: t.clone }).click();
  const first = page.getByTestId("field-editor").first();
  await first.getByRole("group", { name: t.label, exact: true }).getByLabel(t.arabic).fill("عنوان جديد");
  await first.getByRole("group", { name: t.label, exact: true }).getByLabel(t.english).fill("New headline");
  await first.getByLabel(t.searchable, { exact: true }).check();
  await expect(first.getByLabel(t.type, { exact: true }).locator("option")).toHaveCount(10);
  await expect(first.getByLabel(t.type, { exact: true }).locator('option[value="location"]')).toHaveJSProperty("disabled", true);
  await page.getByRole("button", { name: t.preview, exact: true }).click();
  const preview = page.getByRole("region", { name: t.preview, exact: true });
  await preview.getByRole("combobox", { name: t.previewLanguage, exact: true }).selectOption("en");
  await expect(preview.locator('[lang="en"]')).toHaveAttribute("dir", "ltr");
  await preview.getByLabel("New headline", { exact: false }).fill("PREVIEW_ONLY");
  await expect(preview.getByLabel("Detail", { exact: false })).toHaveCount(0);
  await preview.getByLabel("Category", { exact: false }).selectOption("other");
  await expect(preview.getByLabel("Detail", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: t.publish, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: ar.confirm, exact: true }).click();
  await expect(page.getByRole("combobox", { name: t.version, exact: true })).toHaveValue("2");
  const snapshots = await page.evaluate(async () => ({ current: await (await fetch("/api/bff/forms/current")).json(), old: await (await fetch("/api/bff/forms/1")).json(), list: await (await fetch("/api/bff/forms")).json() }));
  expect(snapshots.current.fields[0].searchable).toBe(true); expect(snapshots.current.fields[0].label.en).toBe("New headline"); expect(JSON.stringify(snapshots)).not.toContain("PREVIEW_ONLY");
  expect(snapshots.old.fields[0].label.en).toBe("Headline"); expect(snapshots.list.items.map((i: { version: number }) => i.version)).toEqual([2, 1]);
  await page.getByRole("combobox", { name: t.version, exact: true }).selectOption("1"); await expect(page.getByRole("region", { name: t.preview }).getByLabel("Headline", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: t.clone }).click(); await expect(page.getByRole("heading", { name: `${t.draft} 3` })).toBeVisible();
  expect(errors).toEqual([]);
});

test("edits types and ordering, catches invalid schema, and requires a fresh preview after edits", async ({ page }) => {
  await login(page, "admin", "en"); const t = en.formsAdmin;
  await page.getByRole("button", { name: t.clone }).click(); await page.getByRole("button", { name: t.addField }).click();
  const field = page.getByTestId("field-editor").last();
  await field.getByLabel(t.type, { exact: true }).selectOption("select");
  await field.getByLabel(t.key, { exact: true }).fill("distribution");
  const labels = field.getByRole("group", { name: t.label, exact: true });
  await labels.nth(0).getByLabel(t.arabic).fill("التوزيع"); await labels.nth(0).getByLabel(t.english).fill("Distribution");
  await page.getByRole("button", { name: t.preview, exact: true }).click(); await expect(page.getByText(t.invalid, { exact: true })).toBeVisible();
  await labels.nth(1).getByLabel(t.arabic).fill("محلي"); await labels.nth(1).getByLabel(t.english).fill("Local");
  await field.getByLabel(t.searchable, { exact: true }).check(); await field.getByRole("button", { name: t.up, exact: true }).click();
  const moved = page.getByTestId("field-editor").nth(12); await expect(moved.getByLabel(t.key, { exact: true })).toHaveValue("distribution");
  await page.getByRole("button", { name: t.preview, exact: true }).click(); await expect(page.getByRole("button", { name: t.publish, exact: true })).toBeVisible();
  await moved.getByLabel(t.searchable, { exact: true }).uncheck(); await expect(page.getByRole("button", { name: t.publish, exact: true })).toHaveCount(0);
  await publish(page, "en"); await expect(page.getByRole("combobox", { name: t.version, exact: true })).toHaveValue("2");
  await page.screenshot({ path: ".artifacts/forms-admin-en.png", fullPage: true });
});

test("a lost publication response reuses the same idempotency key without a second version", async ({ page, request }) => {
  await login(page); const t = ar.formsAdmin;
  await page.getByRole("button", { name: t.clone }).click(); await request.post("http://127.0.0.1:3201/__test/drop-write");
  await publish(page); await expect(page.getByText(ar.review.failed, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: t.publish, exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: ar.confirm, exact: true }).dblclick();
  await expect(page.getByRole("combobox", { name: t.version, exact: true })).toHaveValue("2");
  const state = await (await request.get("http://127.0.0.1:3201/__test/state")).json();
  const writes = state.writes.filter((w: { path: string }) => w.path === "/v1/forms"); expect(writes).toHaveLength(2); expect(writes[0].key).toBe(writes[1].key);
});

test("concurrent publication keeps the stale draft; reload requires confirmation", async ({ page }) => {
  await login(page); const t = ar.formsAdmin;
  await page.getByRole("button", { name: t.clone }).click();
  await page.getByTestId("field-editor").first().getByRole("group", { name: t.label, exact: true }).getByLabel(t.arabic).fill("مسودة محفوظة");
  const status = await page.evaluate(async () => {
    const f = await (await fetch("/api/bff/forms/current")).json(); f.version++; delete f.published_at; delete f.published_by;
    return (await fetch("/api/bff/forms", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID(), "If-Match": '"1"' }, body: JSON.stringify(f) })).status;
  }); expect(status).toBe(201);
  await publish(page); await expect(page.getByText(ar.review.changed, { exact: true })).toBeVisible();
  await expect(page.getByTestId("field-editor").first().getByRole("group", { name: t.label, exact: true }).getByLabel(t.arabic)).toHaveValue("مسودة محفوظة");
  await page.getByRole("button", { name: t.discard }).click(); await page.getByRole("dialog").getByRole("button", { name: ar.cancel, exact: true }).click(); await expect(page.getByTestId("field-editor")).toHaveCount(13);
  await page.getByRole("button", { name: t.discard }).click(); await page.getByRole("dialog").getByRole("button", { name: ar.confirm, exact: true }).click(); await expect(page.getByRole("combobox", { name: t.version, exact: true })).toHaveValue("2");
  await expect(page.locator("main")).not.toContainText("never-display-canary");
});

test("chief reads history without publishing and a revoked admin cannot publish", async ({ page, context, request }) => {
  await login(page, "chief"); const t = ar.formsAdmin;
  await expect(page.getByText(t.readOnly, { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: t.clone })).toHaveCount(0);
  await page.screenshot({ path: ".artifacts/forms-admin-ar.png", fullPage: true });
  await context.clearCookies(); await login(page); await page.getByRole("button", { name: t.clone }).click();
  await request.post("http://127.0.0.1:3201/__test/revoke-role"); await publish(page); await expect(page.getByText(ar.review.forbidden, { exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:3201/__test/state")).json(); expect(state.writes.filter((w: { path: string }) => w.path === "/v1/forms")).toHaveLength(0);
  await context.clearCookies(); await login(page, "reporter"); await expect(page.getByText(t.denied, { exact: true })).toBeVisible(); await expect(page.getByTestId("field-editor")).toHaveCount(0);
});
