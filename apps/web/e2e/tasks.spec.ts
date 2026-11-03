import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

// إسناد المادة إلى المونتير و«مهامي» (ADR 0096، ADR 0097؛ W3 وW5–W6 وM3): الخادم الاصطناعي يحمل المهام بجدول انتقالات العقد.
const api = "http://127.0.0.1:3201", title = (n: number) => `مادة اختبار اصطناعية ${String(n).padStart(3, "0")}`, materialId = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });
test.use({ timezoneId: "UTC" });

async function login(page: Page, role: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
const writes = async (page: Page) => (await (await page.request.get(`${api}/__test/state`)).json()).writes as { path: string; method: string; key: string; body: Record<string, unknown> }[];

test("W3 from W2: an accepted material is assigned by load, due and note; the card shows the open task and no second assign", async ({ page }) => {
  await login(page, "reviewer"); await page.goto(`/ar/materials/${materialId(2)}`);
  const card = page.getByTestId("assignment-card"); await expect(card).toContainText(ar.assign.cardNone);
  await card.getByRole("button", { name: ar.assign.action }).click();
  const dialog = page.getByRole("dialog", { name: ar.assign.title }); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`«${title(2)}»`);
  const people = dialog.getByTestId("assign-candidate"); await expect(people).toHaveCount(3);
  await expect(people.nth(0)).toContainText("مونتير تجريبي ١"); await expect(people.nth(0)).toContainText(ar.assign.free); await expect(people.nth(0).getByRole("radio")).toBeChecked();
  await expect(people.nth(1)).toContainText(ar.assign.unnamed);
  await expect(people.nth(2)).toContainText("مونتير تجريبي ٢"); await expect(people.nth(2)).toContainText(ar.assign.openTasks.few.replace("{n}", "3")); await expect(people.nth(2)).toContainText(ar.assign.urgentTasks.replace("{n}", "1"));
  await expect(dialog).not.toContainText("never-display-canary");
  await expect(dialog.getByRole("radio", { name: ar.assign.presets["30m"] })).toBeChecked();
  await dialog.getByText(ar.assign.presets["1h"], { exact: true }).click();
  await dialog.getByLabel(ar.assign.note).fill("  تقرير عاجل 60 ثانية طولي، مع تمويه الوجوه\u202e  ");
  const before = Date.now();
  await dialog.getByRole("button", { name: ar.assign.submit.replace("{name}", "مونتير تجريبي ١") }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText(ar.assign.done.replace("{name}", "مونتير تجريبي ١"));
  await expect(card.getByTestId("task-state")).toHaveText(ar.tasks.state.assigned); await expect(card.getByRole("link", { name: ar.tasks.open })).toBeVisible();
  await expect(card.getByRole("button", { name: ar.assign.action })).toHaveCount(0);
  const post = (await writes(page)).find(w => w.path === `/v1/materials/${materialId(2)}/assignments`)!;
  expect(post.key).toMatch(/^[0-9a-f-]{36}$/); expect(Object.keys(post.body).sort()).toEqual(["assignee_id", "due_at", "note"]);
  expect(post.body.note).toBe("تقرير عاجل 60 ثانية طولي، مع تمويه الوجوه");
  const minutes = (Date.parse(String(post.body.due_at)) - before) / 60000; expect(minutes).toBeGreaterThan(58); expect(minutes).toBeLessThan(62);
});

test("W1 rows offer «حوّل» on accepted materials only, and refusals read as words with the open task linked", async ({ page }) => {
  await login(page, "chief");
  const assign = page.getByTestId("material-row").getByRole("button", { name: new RegExp(`^${ar.assign.action}`) });
  await expect(assign).toHaveCount(1); await expect(assign).toHaveAccessibleName(`${ar.assign.action}: ${title(2)}`);
  const open = "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c";
  await page.route(`**/api/bff/materials/${materialId(2)}/assignments`, route => route.fulfill({ status: 409, json: { code: "assignment_open", details: { assignment_id: open } } }));
  await assign.click(); const dialog = page.getByRole("dialog", { name: ar.assign.title });
  await dialog.getByRole("button", { name: ar.assign.submit.replace("{name}", "مونتير تجريبي ١") }).click();
  await expect(dialog.getByTestId("assign-refusal")).toContainText(ar.assign.open);
  await expect(dialog.getByRole("link", { name: ar.tasks.open })).toHaveAttribute("href", `/ar/tasks/${open}`);
  await page.unroute(`**/api/bff/materials/${materialId(2)}/assignments`);
  await page.route(`**/api/bff/materials/${materialId(2)}/assignments`, route => route.fulfill({ status: 409, json: { code: "assignment_not_allowed", details: { failed: ["editorial_state"] } } }));
  await dialog.getByLabel(ar.assign.note).fill("ملاحظة"); await dialog.getByRole("button", { name: ar.assign.submit.replace("{name}", "مونتير تجريبي ١") }).click();
  await expect(dialog.getByTestId("assign-refusal")).toHaveText(ar.assign.notAllowed);
  await page.keyboard.press("Escape"); await expect(dialog).toBeHidden();
  await page.context().clearCookies(); await login(page, "admin", "en");
  await expect(page.getByTestId("material-row").getByRole("button", { name: new RegExp(`^${en.assign.action}`) })).toHaveCount(0);
});

test("W5: my tasks overdue first then nearest, with words for urgent, sensitive and overdue, and a closed tab", async ({ page, request }) => {
  await request.post(`${api}/__test/assignments`); await login(page, "reviewer");
  await page.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: ar.tasks.nav }).click();
  await expect(page).toHaveURL(/\/ar\/tasks$/); await expect(page.getByRole("heading", { level: 1, name: ar.tasks.title })).toBeVisible();
  const kpis = page.getByTestId("task-kpis"); await expect(kpis).toContainText(`3${ar.tasks.kpiActive}`); await expect(page.getByTestId("kpi-overdue")).toContainText("1"); await expect(kpis).toContainText(`1${ar.tasks.kpiDone}`);
  const cards = page.getByTestId("task-card"); await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText(title(9)); await expect(cards.nth(0)).toContainText(ar.tasks.overdueBadge); await expect(cards.nth(0).getByTestId("task-sensitive")).toHaveText(ar.tasks.sensitive);
  await expect(cards.nth(0).getByTestId("task-due")).toContainText(ar.tasks.due.overdue.split("{time}")[0].trim());
  await expect(cards.nth(1)).toContainText(title(5)); await expect(cards.nth(1)).toHaveClass(/urgent/); await expect(cards.nth(1)).toContainText(ar.states.priority.urgent);
  await expect(cards.nth(1).getByTestId("task-due")).toContainText(ar.tasks.due.soon.split("{time}")[0].trim()); await expect(cards.nth(1)).toContainText(ar.tasks.rushes.few.replace("{n}", "3")); await expect(cards.nth(1)).toContainText("1.0 GB");
  await expect(cards.nth(1)).toContainText(ar.tasks.from.replace("{name}", "محرر تجريبي ١"));
  await expect(cards.nth(2)).toContainText(title(7)); await expect(cards.nth(2).getByTestId("task-state")).toHaveText(ar.tasks.state.in_progress);
  await expect(cards.nth(1).getByRole("link", { name: ar.tasks.download })).toHaveAttribute("href", /\/ar\/tasks\/[0-9a-f-]{36}#rushes$/);
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  await page.getByRole("button", { name: ar.tasks.tabs.closed }).click();
  await expect(cards).toHaveCount(1); await expect(cards.first()).toContainText(title(13)); await expect(cards.first().getByTestId("task-state")).toHaveText(ar.tasks.state.done);
  await expect(cards.first().getByRole("link", { name: ar.tasks.download })).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 }); await page.getByRole("button", { name: ar.tasks.tabs.active }).click(); await expect(cards).toHaveCount(3);
  await page.screenshot({ path: ".artifacts/tasks-w05.png" });
});

test("M3: on the phone the tasks sit in the bottom bar after the inbox, cards stack, and the phone note shows", async ({ page, request }) => {
  await request.post(`${api}/__test/assignments`); await login(page, "reviewer");
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto("/ar/tasks");
  const bar = page.getByRole("navigation", { name: ar.shell.bottomNav });
  const links = bar.getByRole("link"); await expect(links.nth(0)).toHaveAccessibleName(ar.inbox); await expect(links.nth(1)).toHaveAccessibleName(ar.tasks.nav); await expect(links.nth(1)).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("task-kpis")).toBeHidden(); await expect(page.getByText(ar.tasks.phoneNote)).toBeVisible();
  const card = page.getByTestId("task-card").nth(1); await expect(card.getByRole("link", { name: ar.tasks.download })).toBeVisible();
  const box = await card.getByRole("link", { name: ar.tasks.download }).boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".artifacts/tasks-m3.png", fullPage: true });
});

test("W6: the editor's note, the rushes and their package, and the task moves through its states", async ({ page, request }) => {
  await request.post(`${api}/__test/assignments`); await login(page, "reviewer");
  await page.goto("/ar/tasks"); await page.getByTestId("task-card").nth(1).getByRole("link", { name: ar.tasks.open }).click();
  await expect(page.getByRole("heading", { level: 1, name: title(5) })).toBeVisible();
  await expect(page.getByTestId("task-meta")).toContainText(ar.states.priority.urgent); await expect(page.getByTestId("task-meta")).toContainText("محرر تجريبي ١");
  await expect(page.getByTestId("task-note")).toHaveText("تقرير عاجل 60 ثانية طولي، مع تمويه الوجوه");
  const rushes = page.getByTestId("rushes"); await expect(rushes.getByTestId("rush")).toHaveCount(3);
  await expect(rushes.getByTestId("rush").nth(0)).toContainText(`${ar.task.clip.replace("{n}", "1")} · 1:42`); await expect(rushes.getByTestId("rush").nth(0)).toContainText("420 MB");
  await expect(rushes.getByTestId("rush").nth(2)).toContainText(ar.task.photo.replace("{n}", "3"));
  await page.route("**/derived/fixture*", route => route.fulfill({ body: "synthetic package", headers: { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=package.zip" } }));
  const downloaded = page.waitForEvent("download", { timeout: 20000 });
  await rushes.getByTestId("download-all").click(); await expect(rushes.getByTestId("export-preparing")).toBeVisible();
  await downloaded;
  const exportWrite = (await writes(page)).find(w => w.path === `/v1/materials/${materialId(5)}/export`); expect(exportWrite?.body).toEqual({});
  const actions = page.getByTestId("task-actions");
  await actions.getByRole("button", { name: ar.task.act.acknowledged }).click(); await expect(page.getByTestId("task-meta").getByTestId("task-state")).toHaveText(ar.tasks.state.acknowledged);
  await actions.getByRole("button", { name: ar.task.act.in_progress }).click(); await expect(page.getByTestId("task-meta").getByTestId("task-state")).toHaveText(ar.tasks.state.in_progress);
  await expect(actions).toContainText(ar.task.doneHint);
  await actions.getByRole("button", { name: ar.task.act.done }).click();
  const confirm = page.getByTestId("confirm-done"); await expect(confirm).toContainText(ar.task.produced.effectWithout); await confirm.getByRole("button", { name: ar.task.act.done }).click();
  await expect(actions.getByTestId("task-closed")).toContainText(ar.task.closedDone.split("{time}")[0].trim());
  await expect(actions.getByRole("button")).toHaveCount(0);
  const moves = (await writes(page)).filter(w => w.path.endsWith("/transitions") && w.path.startsWith("/v1/assignments/")).map(w => w.body); expect(moves).toEqual([{ to: "acknowledged" }, { to: "in_progress" }, { to: "done" }]);
});

test("W6: returning a task takes an optional reason that stays out of the notification, and a manager sees return only", async ({ page, request }) => {
  await request.post(`${api}/__test/assignments`); await login(page, "reviewer");
  await page.goto("/ar/tasks"); await page.getByTestId("task-card").nth(2).getByRole("link", { name: ar.tasks.open }).click();
  const actions = page.getByTestId("task-actions"); await actions.getByRole("button", { name: ar.task.act.returned }).click();
  await actions.getByLabel(ar.task.returnReason).fill("المادة غير كافية للتقرير"); await actions.getByRole("button", { name: ar.task.confirmReturn }).click();
  await expect(actions.getByTestId("task-closed")).toContainText(ar.task.closedReturned.split("{time}")[0].trim());
  await expect(page.getByText("المادة غير كافية للتقرير")).toBeVisible();
  expect((await writes(page)).filter(w => w.path.endsWith("/transitions") && w.path.startsWith("/v1/assignments/")).map(w => w.body)).toEqual([{ to: "returned", note: "المادة غير كافية للتقرير" }]);
  const url = page.url(); await page.context().clearCookies(); await login(page, "chief", "en"); await page.goto(url.replace("/ar/", "/en/"));
  await expect(page.getByTestId("task-actions").getByTestId("task-closed")).toContainText(en.task.closedReturned.split("{time}")[0].trim());
  // من يملك الإسناد على مهمة مفتوحة لغيره: «أعد المهمة» وحدها، وسطر المونتير. (الحسابات الاصطناعية تتشارك معرّفًا، فالمهمة هنا لمونتير آخر.)
  const id = url.split("/").pop()!, other = "10000000-0000-4000-8000-000000000003";
  await page.route(`**/api/bff/assignments/${id}`, async route => { const response = await route.fetch(), data = await response.json(); await route.fulfill({ response, json: { ...data, state: "in_progress", assignee_id: other, assignee_name: "مونتير تجريبي ٢", closed_at: null, returned_by: null, return_note: null, started_at: data.created_at, acknowledged_at: data.created_at } }); });
  await page.reload(); const manager = page.getByTestId("task-actions");
  await expect(manager.getByRole("button", { name: en.task.act.returned })).toBeVisible(); await expect(manager.getByRole("button", { name: en.task.act.done })).toHaveCount(0);
  await expect(page.getByText(en.task.assignee.replace("{name}", "مونتير تجريبي ٢"))).toBeVisible();
  await page.goto("/en/tasks"); await expect(page.getByTestId("no-access")).toBeVisible();
});

test("a task notification opens the task, not the material", async ({ page }) => {
  await login(page, "reviewer");
  const task = "6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c";
  await page.route("**/api/bff/notifications?*", route => route.fulfill({ json: { unread_count: 1, next_cursor: null, items: [{ id: "60000000-0000-4000-8000-000000000009", type: "", title: "", material_id: materialId(2), assignment_id: task, priority: "urgent", state: "sent", assignment_state: "assigned", created_at: new Date().toISOString() }] } }));
  await page.getByRole("button", { name: ar.shell.bell.open, exact: true }).first().click();
  await expect(page.getByTestId("bell-item").getByRole("link")).toHaveAttribute("href", `/ar/tasks/${task}`);
});
