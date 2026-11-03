import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

// فجوات البناء على الويب (ADR 0105) على الخادم الاصطناعي: الأدوار، رفض الطلب، مفتاحا الحقل، النسخة المُنتَجة، المصغّرة ورقاقات النوع، وسوم المكتب.
// كل تأكيد يقول أثره، و412 يعيد التحميل ويقوله، والصفحات تعمل على 1280 و375 بلا تمرير جانبي.
const api = "http://127.0.0.1:3201", key = /^[0-9a-f-]{36}$/;
const title = (n: number) => `مادة اختبار اصطناعية ${String(n).padStart(3, "0")}`, materialId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
type Write = { path: string; method: string; key: string; body: Record<string, unknown> };
const writes = async (request: APIRequestContext, path: string) => ((await (await request.get(`${api}/__test/state`)).json()).writes as Write[]).filter(w => w.path === path);
async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page).not.toHaveURL(/\/login/);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });
test.afterAll(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("A1: roles are read, changed after a confirmation that states them, scoped for the supervisor, and refused for oneself", async ({ page, request }) => {
  const t = ar.admin.roles, labels = ar.topbar.roles; await login(page, "admin"); await page.goto("/ar/admin");
  const name = "مونتير تجريبي ١", id = "10000000-0000-4000-8000-000000000007";
  await page.getByTestId("staff-row").filter({ hasText: name }).getByRole("button", { name: fill(ar.admin.manage, { name }) }).click();
  const card = page.getByTestId("roles-card"); await expect(card.getByTestId("role-lines")).toHaveText(labels.producer);
  await card.getByRole("button", { name: t.edit }).click();
  await card.getByRole("checkbox", { name: labels.supervisor }).check(); await expect(card.getByTestId("scope-group")).toBeVisible();
  await card.getByRole("radio", { name: t.scopeSome }).check(); await expect(card.getByText(t.scopeEmpty)).toBeVisible(); await expect(card.getByRole("button", { name: t.save })).toBeDisabled();
  await card.getByLabel(t.scopeLabel).fill("محافظة تجريبية ١"); await card.getByRole("button", { name: t.scopeAdd }).click();
  await expect(card.getByRole("button", { name: fill(t.scopeRemove, { scope: "محافظة تجريبية ١" }) })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await card.getByRole("button", { name: t.save }).click();
  const dialog = page.getByTestId("confirm-roles"); await expect(dialog).toContainText(fill(t.effect, { name, roles: `${labels.supervisor} (محافظة تجريبية ١)${ar.shell.listSeparator}${labels.producer}` }));
  await dialog.getByRole("button", { name: t.save }).click(); await expect(card.getByText(t.changed)).toBeVisible();
  await expect(card.getByTestId("role-lines").locator("li")).toHaveCount(2);
  const [write] = await writes(request, `/v1/users/${id}/roles`); expect(write.key).toMatch(key);
  expect(write.body).toEqual({ roles: [{ name: "supervisor", scopes: [{ kind: "governorate", id: "محافظة تجريبية ١" }] }, { name: "producer", scopes: [] }] });
  // محافظة لا مكتب فيها: 422 بكلمات، ولا تتغيّر الأدوار.
  await card.getByRole("button", { name: t.edit }).click(); await card.getByLabel(t.scopeLabel).fill("محافظة أخرى"); await card.getByRole("button", { name: t.scopeAdd }).click();
  await card.getByRole("button", { name: t.save }).click(); await page.getByTestId("confirm-roles").getByRole("button", { name: t.save }).click();
  await expect(card.getByText(t.invalid)).toBeVisible(); await card.getByRole("button", { name: t.cancel }).click();
  await page.screenshot({ path: ".artifacts/a1-roles-ar.png", fullPage: true });
  await page.getByRole("button", { name: ar.admin.back }).click();
  const self = "مدير تجريبي ١"; await page.getByTestId("staff-row").filter({ hasText: self }).getByRole("button", { name: fill(ar.admin.manage, { name: self }) }).click();
  await expect(page.getByTestId("roles-card").getByRole("button", { name: t.edit })).toBeDisabled(); await expect(page.getByTestId("roles-card")).toContainText(t.self);
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
});

test("A5: a join request is rejected with a closed reason after a confirmation; the organization's admin sees why instead of the catalog", async ({ page, request }) => {
  const t = ar.buyers.reject; await login(page, "admin"); await page.goto("/ar/buyer-organizations");
  const card = page.getByTestId("join-request"); await card.getByTestId("reject-request").click();
  const dialog = page.getByTestId("confirm-reject"); await expect(dialog).toContainText(fill(t.effect, { name: "مؤسسة أخرى" }));
  await expect(dialog.getByRole("button", { name: t.action, exact: true })).toBeDisabled();
  await dialog.getByTestId("reject-reason").selectOption("duplicate_organization");
  const post = page.waitForRequest(r => r.url().endsWith("/rejection") && r.method() === "POST");
  await dialog.getByRole("button", { name: t.action, exact: true }).click(); const sent = await post;
  expect(sent.headers()["if-match"]).toBe('"1"'); expect(sent.postDataJSON()).toEqual({ reason_code: "duplicate_organization" });
  await expect(page.getByTestId("join-request")).toHaveCount(0);
  await expect(page.getByTestId("organization-row").filter({ hasText: "مؤسسة أخرى" })).toContainText(ar.buyers.statuses.rejected);
  expect(await writes(request, "/v1/buyer-organizations/90000000-0000-4000-8000-000000000002/rejection")).toHaveLength(1);
  await page.context().clearCookies(); await login(page, "pendingbuyer"); await page.goto("/ar/store");
  const held = page.getByTestId("org-pending"); await expect(held).toHaveAttribute("data-status", "rejected");
  await expect(held).toContainText(ar.store.org.rejected.title); await expect(held.getByTestId("org-pending-body")).toContainText(ar.store.org.rejected.reasons.duplicate_organization);
  await expect(held.getByRole("link", { name: ar.store.org.invite })).toHaveCount(0); await expect(page.locator("main")).not.toContainText("never-display-canary");
  for (const width of [1280, 375]) { await page.setViewportSize({ width, height: 812 }); expect(await noSideScroll(page)).toBe(true); }
  await page.screenshot({ path: ".artifacts/a5-rejected-phone.png", fullPage: true });
});

test("A3: the two toggles are field properties on the new version; required keeps urgent on, and staff names never go to the store", async ({ page }) => {
  const t = ar.formsAdmin; await login(page, "admin"); await page.goto("/ar/forms");
  await page.getByRole("button", { name: t.clone }).click();
  await page.getByRole("button", { name: fill(t.addType, { type: t.types.number }) }).click();
  const editor = page.getByTestId("field-editor"), urgent = editor.getByTestId("toggle-urgent"), store = editor.getByTestId("toggle-store");
  await expect(urgent).toBeChecked(); await expect(store).not.toBeChecked();
  await editor.getByLabel(t.required, { exact: true }).check(); await expect(urgent).toBeChecked(); await expect(urgent).toBeDisabled();
  await editor.getByLabel(t.required, { exact: true }).uncheck(); await urgent.uncheck(); await store.check();
  const row = page.getByTestId("field-row").last(); await expect(row.getByTestId("badge-out-of-urgent")).toHaveText(t.toggles.outOfUrgent); await expect(row.getByTestId("badge-to-store")).toHaveText(t.toggles.storeBadge);
  await editor.getByLabel(t.type, { exact: true }).selectOption("staff_member"); await expect(store).not.toBeChecked(); await expect(store).toBeDisabled(); await expect(row.getByTestId("badge-to-store")).toHaveCount(0);
  await editor.getByLabel(t.type, { exact: true }).selectOption("number"); await store.check();
  await editor.getByRole("group", { name: t.label, exact: true }).getByLabel(t.arabic).fill("عدد الوجوه"); await editor.getByRole("group", { name: t.label, exact: true }).getByLabel(t.english).fill("Faces");
  await editor.getByLabel(t.key, { exact: true }).fill("faces");
  await page.getByRole("button", { name: t.preview, exact: true }).click();
  await page.getByRole("button", { name: fill(t.publishVersion, { version: 2 }), exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: ar.confirm, exact: true }).click();
  await expect(page.getByRole("combobox", { name: t.version, exact: true })).toHaveValue("2");
  const current = await page.evaluate(async () => (await fetch("/api/bff/forms/current")).json());
  const faces = current.fields.find((f: { key: string }) => f.key === "faces"); expect(faces).toMatchObject({ show_in_urgent: false, send_to_store: true });
  await page.getByTestId("field-row").last().getByRole("button").first().click(); await expect(page.locator(".field-summary")).toContainText(t.toggles.toStore);
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
});

test("W6: the producer uploads the produced file on the same tus path, «done» says it carries it, and the editor-in-chief downloads it", async ({ page, request }) => {
  const t = ar.task.produced; await request.post(`${api}/__test/assignments`); await login(page, "reviewer");
  await page.goto("/ar/tasks"); await page.getByTestId("task-card").nth(2).getByRole("link", { name: ar.tasks.open }).click();
  await expect(page.getByRole("heading", { level: 1, name: title(7) })).toBeVisible();
  const card = page.getByTestId("produced-upload"); await expect(card).toContainText(t.lead);
  await card.getByTestId("produced-input").setInputFiles({ name: "edit-final.mp4", mimeType: "video/mp4", buffer: randomBytes(1048576 + 77) });
  await expect(card).toHaveAttribute("data-stage", "verified", { timeout: 20000 }); await expect(card).toContainText(t.ready);
  const actions = page.getByTestId("task-actions"); await actions.getByTestId("act-done").click();
  const dialog = page.getByTestId("confirm-done"); await expect(dialog).toContainText(t.effectWithFile); await expect(dialog).toContainText("edit-final.mp4");
  await dialog.getByRole("button", { name: ar.task.act.done }).click();
  await expect(actions.getByTestId("task-delivered")).toHaveText(t.deliveredWith); await expect(page.getByTestId("produced-upload")).toHaveCount(0);
  const moves = ((await (await request.get(`${api}/__test/state`)).json()).writes as Write[]).filter(w => w.path.startsWith("/v1/assignments/") && w.path.endsWith("/transitions"));
  expect(moves).toHaveLength(1); expect(Object.keys(moves[0].body).sort()).toEqual(["produced_file_id", "to"]); expect(moves[0].body.to).toBe("done"); expect(String(moves[0].body.produced_file_id)).toMatch(key);
  const uploads = ((await (await request.get(`${api}/__test/state`)).json()).writes as Write[]).filter(w => w.path === "/v1/uploads"); expect(uploads.at(-1)!.body.kind).toBe("produced");
  const url = page.url(); await page.context().clearCookies(); await login(page, "chief"); await page.goto(url);
  await page.route("**/derived/fixture*", route => route.fulfill({ body: "synthetic produced file", headers: { "Content-Type": "video/mp4", "Content-Disposition": "attachment; filename=produced.mp4" } }));
  const downloaded = page.waitForEvent("download"); await page.getByTestId("produced-download").click(); await downloaded;
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: ".artifacts/w6-produced-phone.png", fullPage: true });
});

test("W6: «done» without a file states that effect and sends no file id", async ({ page, request }) => {
  await request.post(`${api}/__test/assignments`); await login(page, "reviewer", "en");
  await page.goto("/en/tasks"); await page.getByTestId("task-card").nth(2).getByRole("link", { name: en.tasks.open }).click();
  await page.getByTestId("task-actions").getByTestId("act-done").click();
  const dialog = page.getByTestId("confirm-done"); await expect(dialog).toContainText(en.task.produced.effectWithout);
  await dialog.getByRole("button", { name: en.cancel, exact: true }).click(); expect(((await (await request.get(`${api}/__test/state`)).json()).writes as Write[]).filter(w => w.path.endsWith("/transitions"))).toHaveLength(0);
  await page.getByTestId("task-actions").getByTestId("act-done").click(); await page.getByTestId("confirm-done").getByRole("button", { name: en.task.act.done }).click();
  await expect(page.getByTestId("task-delivered")).toHaveText(en.task.produced.deliveredWithout); await expect(page.getByTestId("produced-download")).toHaveCount(0);
});

test("W1: verified thumbnails on rows, none fetched for a sensitive material, and type chips filter the loaded page", async ({ page, request }) => {
  const w = ar.shell.inbox.typeFilter; await request.post(`${api}/__test/thumbs`);
  const fetched: string[] = []; page.on("request", r => { if (r.url().includes("/files/") && r.url().endsWith("/content")) fetched.push(r.url()); });
  await login(page, "chief"); await expect(page.getByTestId("material-row")).toHaveCount(50);
  const row = page.getByTestId("material-row").filter({ hasText: title(1) }); await row.scrollIntoViewIfNeeded();
  const image = row.getByTestId("row-thumb-image"); await expect(image).toHaveAttribute("src", new RegExp(`/api/bff/materials/${materialId(1)}/files/40000000-0000-4000-8000-000000000001/content$`));
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  const sensitive = page.getByTestId("material-row").filter({ hasText: title(4) }); await sensitive.scrollIntoViewIfNeeded();
  await expect(sensitive.getByTestId("row-thumb-sensitive")).toContainText(w.sensitive); await expect(sensitive.locator("img")).toHaveCount(0);
  await expect(page.getByTestId("material-row").filter({ hasText: title(10) }).locator("img")).toHaveCount(0);
  expect(fetched.some(url => url.includes(materialId(4)))).toBe(false);
  const chips = page.getByTestId("type-chips"); await chips.getByRole("button", { name: ar.types.photos, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(1); await expect(page.getByTestId("material-row")).toContainText(title(4));
  await expect(chips.getByRole("button", { name: ar.types.photos, exact: true })).toHaveAttribute("aria-pressed", "true");
  await chips.getByRole("button", { name: ar.types.interview, exact: true }).click(); await expect(page.getByTestId("inbox-no-results")).toBeVisible();
  await chips.getByRole("button", { name: w.all, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: ".artifacts/w1-thumbs-phone.png" });
});

test("W2: the supervisor edits tags with If-Match after a confirmation; a stale row reloads and says so; a producer only reads", async ({ page, request }) => {
  const t = ar.shell.material.tagEditor; await login(page, "reviewer"); await page.goto(`/ar/materials/${materialId(1)}`);
  const tags = page.getByTestId("material-tags"); await expect(tags).toContainText(t.none);
  await tags.getByTestId("edit-tags").click(); const editor = page.getByTestId("tag-editor");
  await editor.getByRole("button", { name: "وسم تجريبي ١", exact: true }).click();
  await editor.getByLabel(t.add).fill("و".repeat(41)); await expect(editor.getByText(t.invalid)).toBeVisible(); await expect(editor.getByRole("button", { name: t.addButton })).toBeDisabled();
  await editor.getByLabel(t.add).fill("خيام"); await editor.getByLabel(t.add).press("Enter");
  await expect(editor.getByRole("button", { name: fill(t.remove, { tag: "خيام" }) })).toBeVisible();
  await editor.getByRole("button", { name: t.save }).click();
  const dialog = page.getByTestId("confirm-tags"); await expect(dialog).toContainText(fill(t.effect, { n: 2 }));
  await dialog.getByRole("button", { name: t.save }).click(); await expect(page.getByTestId("material-tags")).toContainText(t.saved);
  await expect(page.getByTestId("material-tags").locator(".tag-list li")).toHaveText(["وسم تجريبي ١", "خيام"]);
  const [write] = await writes(request, `/v1/materials/${materialId(1)}/tags`); expect(write.body).toEqual({ tags: ["وسم تجريبي ١", "خيام"] }); expect(write.key).toMatch(key);
  await request.post(`${api}/__test/materials/${materialId(1)}/bump`);
  await page.getByTestId("edit-tags").click(); await page.getByTestId("tag-editor").getByRole("button", { name: fill(t.remove, { tag: "خيام" }) }).click();
  await page.getByTestId("tag-editor").getByRole("button", { name: t.save }).click(); await page.getByTestId("confirm-tags").getByRole("button", { name: t.save }).click();
  await expect(page.getByTestId("tags-stale")).toHaveText(t.stale); await expect(page.getByTestId("material-tags")).toContainText("وسم من جلسة أخرى");
  expect(await writes(request, `/v1/materials/${materialId(1)}/tags`)).toHaveLength(2);
  await page.setViewportSize({ width: 375, height: 812 }); expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: ".artifacts/w2-tags-phone.png", fullPage: true });
  await page.context().clearCookies(); await login(page, "admin", "en"); await page.goto(`/en/materials/${materialId(1)}`);
  await expect(page.getByTestId("material-tags")).toContainText("وسم تجريبي ١"); await expect(page.getByTestId("edit-tags")).toHaveCount(0);
});
