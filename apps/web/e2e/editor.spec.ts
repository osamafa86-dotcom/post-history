import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
async function login(page: Page, role = "reviewer", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

test("the inbox leads with unseen urgent material and the newsroom counters", async ({ page }) => {
  await login(page); const alert = page.getByTestId("urgent-alert");
  await expect(alert).toBeVisible(); await expect(alert.getByTestId("urgent-count")).toHaveText("40"); await expect(alert.getByRole("heading")).toContainText(ar.shell.inbox.kpiUrgent); await expect(alert.getByTestId("urgent-since")).toHaveText(/\S/); await expect(alert.getByTestId("urgent-since")).not.toContainText(":");
  await expect(page.getByTestId("stat-urgent")).toBeVisible();
  await alert.getByRole("button", { name: ar.editor.showUrgent }).click(); await expect(page.getByTestId("material-row")).toHaveCount(40); await expect(page.getByTestId("material-row").filter({ hasText: ar.states.priority.urgent })).toHaveCount(40);
  await expect(page.locator(".filter-panel")).toBeHidden();
  await page.screenshot({ path: ".artifacts/editor-inbox-ar.png" });
});

test("the transition dialog shows the reporter's message and asks twice before rejecting", async ({ page }) => {
  await login(page); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: ar.review.open, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: ar.review.dialogTitle });
  await dialog.getByRole("radio", { name: ar.states.editorial_state.rejected }).check(); await dialog.getByLabel(ar.review.reason, { exact: true }).fill("short");
  await expect(dialog.getByRole("region", { name: ar.review.previewTitle })).toContainText(ar.states.editorial_state.rejected);
  await dialog.getByLabel(ar.review.reason, { exact: true }).fill("خارج نطاق التغطية"); await expect(dialog.getByText(ar.review.rejectHelp)).toBeVisible();
  await dialog.getByRole("button", { name: ar.review.confirmTo.replace("{state}", ar.states.editorial_state.rejected) }).click();
  const final = dialog.getByRole("button", { name: ar.review.confirmReject }); await expect(final).toBeVisible(); await page.screenshot({ path: ".artifacts/editor-dialog-ar.png" });
  await final.click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".state-grid [data-track='editorial_state']")).toHaveText(ar.states.editorial_state.rejected);
  await expect(page.getByRole("status").filter({ hasText: ar.states.editorial_state.rejected })).toBeVisible();
});

test("the reason must be at least five characters and Escape returns focus to the opener", async ({ page }) => {
  await login(page, "reviewer", "en"); await page.goto("/en/materials/20000000-0000-4000-8000-000000000001");
  const open = page.getByRole("button", { name: en.review.open, exact: true }); await open.click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("radio", { name: en.states.editorial_state.acknowledged }).check(); await dialog.getByLabel(en.review.reason, { exact: true }).fill("ok");
  await expect(dialog.getByRole("button", { name: en.review.confirmTo.replace("{state}", en.states.editorial_state.acknowledged) })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(open).toBeFocused();
});

test("state cards filter the timeline by their track", async ({ page }) => {
  await login(page); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: ar.review.open, exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: ar.states.editorial_state.acknowledged }).check(); await dialog.getByLabel(ar.review.reason, { exact: true }).fill("seen in review"); await dialog.getByRole("button", { name: /^تأكيد/ }).click();
  await expect(page.locator(".history-list li")).toHaveCount(1);
  const rights = page.locator(".state-card.track-rights"); await rights.click(); await expect(rights).toHaveAttribute("aria-pressed", "true"); await expect(page.locator(".history-list li")).toHaveCount(0);
  await rights.click(); await expect(page.locator(".history-list li")).toHaveCount(1);
});

test("notifications are compact, sectioned and navigable with j/k", async ({ page }) => {
  await login(page); await page.getByRole("link", { name: ar.notice.title, exact: true }).click();
  const rows = page.getByTestId("notification"); await expect(rows).toHaveCount(3);
  await rows.first().focus(); await page.keyboard.press("j"); await expect(rows.nth(1)).toHaveClass(/selected/);
  await expect(page.locator(".notification-preview-panel")).not.toContainText(ar.notice.choose);
  await page.getByRole("button", { name: ar.notice.readAll }).click(); await expect(page.getByRole("button", { name: ar.notice.readAll })).toBeDisabled();
});

test("below 768px the inbox rows become cards with the time and place, and the bottom bar takes over (M1)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const row = page.getByTestId("material-row").first();
  await expect(row.locator(".row-states")).not.toBeVisible(); await expect(row.locator(".row-time")).toBeVisible(); await expect(row.locator(".row-meta")).toContainText(ar.networkName);
  expect((await row.locator(".row-thumb").boundingBox())!.width).toBe(72);
  await expect(page.getByRole("navigation", { name: ar.shell.bottomNav })).toBeVisible(); await expect(page.getByTestId("sidebar")).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".artifacts/editor-inbox-phone-ar.png" });
});

for (const locale of ["ar", "en"] as const) test(`ADR 0035 timeline uses work names and neutral null actors (${locale})`, async ({ page }) => {
  const m = locale === "ar" ? ar : en;
  await login(page, "reviewer", locale);
  await page.route("**/api/bff/materials/*/transitions", route => route.fulfill({ json: { items: [
    { id: "one", track: "editorial", from: "inbox", to: "reviewing", reason: "", actor_id: "10000000-0000-4000-8000-000000000002", actor_name: "Synthetic staff", occurred_at: "2026-10-27T10:00:00Z" },
    { id: "two", track: "editorial", from: "reviewing", to: "accepted", reason: "", actor_id: "10000000-0000-4000-8000-000000000003", actor_name: null, occurred_at: "2026-10-27T10:01:00Z" },
  ] } }));
  await page.goto(`/${locale}/materials/20000000-0000-4000-8000-000000000001`);
  await expect(page.locator(".history-list")).toContainText("Synthetic staff"); await expect(page.locator(".history-list")).toContainText(m.material.neutralActor);
  await expect(page.locator(".history-list")).not.toContainText("10000000");
});

test("ADR 0035 read-all sends one stable request and cutoff across a lost response", async ({ page }) => {
  await login(page); await page.goto("/ar/notifications");
  const writes: { key: string | undefined; body: unknown }[] = [];
  await page.route("**/api/bff/notifications/read-all", async route => {
    writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (writes.length === 1) await route.fulfill({ status: 503, json: { code: "temporarily_unavailable" } }); else await route.continue();
  });
  const button = page.getByRole("button", { name: ar.notice.readAll, exact: true }); await button.click();
  await expect(page.locator("main").getByRole("alert")).toBeVisible(); await button.click(); await expect(button).toBeDisabled();
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]); expect(writes[0].key).toBeTruthy(); expect(Object.keys(writes[0].body as object)).toEqual(["before"]);
});

test("the inbox follows W1: summary, chips with counts, top-bar search and rows with three separate state badges, in RTL and LTR", async ({ page }) => {
  await login(page); await page.setViewportSize({ width: 1440, height: 900 }); const w = ar.shell.inbox;
  await expect(page.locator(".inbox-head h1")).toHaveText(ar.inbox); await expect(page.locator(".inbox-summary")).toHaveCount(0);
  await expect(page.getByTestId("kpis").locator(".kpi")).toHaveCount(4); await expect(page.getByTestId("stat-urgent")).toContainText(w.kpiUrgent);
  const tabs = page.getByRole("navigation", { name: ar.inboxTabs.label }), tab = (label: string) => tabs.getByRole("button", { name: new RegExp(`^${label}`) });
  await expect(tabs.getByRole("button")).toHaveCount(6); await expect(tab(ar.inboxTabs.all)).toHaveAttribute("aria-pressed", "true"); await expect(tab(ar.inboxTabs.all)).toContainText("200"); await expect(tab(ar.inboxTabs.urgent)).toContainText("40");
  // الحالات الثلاث شارات منفصلة، كلٌّ بأيقونة وكلمة، ولا تُترك للون وحده.
  const first = page.getByTestId("material-row").first();
  for (const [track, label] of [["technical_state", ar.states.technical_state.verified], ["editorial_state", ar.states.editorial_state.inbox], ["rights_state", ar.states.rights_state.unknown]]) {
    const badge = first.locator(`[data-track='${track}']`); await expect(badge).toHaveText(label); await expect(badge.locator("svg")).toHaveCount(1);
  }
  await tab(ar.inboxTabs.urgent).click(); await expect(tab(ar.inboxTabs.urgent)).toHaveAttribute("aria-pressed", "true"); await expect(page.getByTestId("material-row")).toHaveCount(40);
  const urgent = page.getByTestId("material-row").first(); await expect(urgent).toHaveClass(/urgent/); await expect(urgent).toHaveCSS("border-inline-start-width", "6px");
  await expect(urgent.locator(".priority-pill.urgent")).toHaveText(ar.states.priority.urgent); await expect(urgent.locator(".priority-pill svg")).toHaveCount(1);
  await expect(page.getByRole("list", { name: w.activeFilters })).toContainText(ar.inboxTabs.urgent);
  await tab(ar.inboxTabs.stopped).click(); await expect(page.getByTestId("material-row")).toHaveCount(1);
  await expect(page.getByTestId("material-row").locator("[data-track='technical_state']")).toHaveAttribute("data-state", "failed"); await expect(page.getByTestId("material-row").locator("[data-track='technical_state']")).toHaveText(ar.states.technical_state.failed);
  await tab(ar.inboxTabs.all).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.getByLabel(ar.inboxSearch.label).fill("rcpt-20261020-000050"); await expect(page.getByTestId("material-row")).toHaveCount(1); await expect(page.getByTestId("material-row")).toContainText("RCPT-20261020-000050");
  // E4: بحث بلا نتائج يقول ما بحثتَ عنه، ويعرض المرشّح رقاقة قابلة للإزالة، ويقترح العدد بلا بحث.
  await page.getByLabel(ar.inboxSearch.label).fill("zzz"); const none = page.getByTestId("inbox-no-results");
  await expect(none).toContainText(w.noResultsFor.replace("{q}", "zzz")); await expect(none.getByRole("button", { name: w.showWithoutSearch.replace("{n}", "50") })).toBeVisible();
  await page.getByRole("list", { name: w.activeFilters }).getByRole("button", { name: w.removeFilter.replace("{filter}", "«zzz»") }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50); await expect(page.getByLabel(ar.inboxSearch.label)).toHaveValue("");
  await expect(page.locator(".filter-panel")).toBeHidden();
  await page.screenshot({ path: ".artifacts/inbox-w1-ar.png" });
  await page.goto("/en/inbox"); await expect(page.getByTestId("material-row")).toHaveCount(50); await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  const row = page.getByTestId("material-row").first(), x = async (selector: string) => (await row.locator(selector).boundingBox())!.x;
  expect(await x(".row-thumb")).toBeLessThan(await x(".row-states")); expect(await x(".row-main")).toBeLessThan(await x(".row-actions"));
  await expect(row.locator("[data-track='technical_state']")).toHaveText(en.states.technical_state.verified);
  await expect(page.getByRole("navigation", { name: en.inboxTabs.label }).getByRole("button", { name: new RegExp(`^${en.inboxTabs.all}`) })).toContainText("200");
});

test("the inbox shows skeletons while loading, keeps the last rows with disabled actions offline, and says when it is empty (E1–E3)", async ({ page, context }) => {
  await login(page); const w = ar.shell.inbox;
  // E3: آخر بيانات كما هي، ووقت آخر تحديث، والأفعال معطّلة.
  await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByTestId("offline-banner")).toContainText(w.offlineTitle); await expect(page.locator(".live-line")).toContainText(ar.updated);
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  for (const button of await page.getByTestId("material-row").first().getByRole("button").all()) await expect(button).toBeDisabled();
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online"))); await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  // E2: هياكل بشكل الصفوف، ومع «تقليل الحركة» بلا وميض.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/bff/materials?**", () => new Promise(() => {})); await page.reload();
  const skeleton = page.getByTestId("inbox-skeleton"); await expect(skeleton).toBeVisible(); await expect(skeleton.locator(".skeleton").first()).toHaveCSS("animation-name", "none");
  // E1: الوارد فارغ يقول متى تصل المواد.
  await page.unroute("**/api/bff/materials?**"); await page.route("**/api/bff/materials?**", route => route.fulfill({ json: { items: [], next_cursor: null } })); await page.reload();
  await expect(page.getByTestId("inbox-empty")).toContainText(w.emptyTitle); await expect(page.getByTestId("inbox-empty")).toContainText(w.emptyBody);
});

test("the material page follows W2: breadcrumb, player, separate states, the sensitivity line, the next step and the log, with no coordinates", async ({ page }) => {
  await login(page); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000005"); const w = ar.shell.material;
  await expect(page.getByRole("navigation", { name: w.breadcrumb })).toContainText(ar.inbox);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); await expect(page.locator(".material-title .priority-pill.urgent")).toBeVisible();
  await expect(page.getByTestId("sensitivity-line")).toContainText(w.sensitivity); await expect(page.getByTestId("sensitivity-line")).toContainText(w.notSensitive); await expect(page.locator(".material-meta")).toContainText("مدينة اختبار");
  // فاصل المسار أيقونة تشير إلى نهاية السطر: معكوسة في RTL، وكما هي في LTR.
  await expect(page.locator(".breadcrumb-sep")).toHaveCSS("transform", "matrix(-1, 0, 0, 1, 0, 0)"); await expect(page.locator(".breadcrumb")).not.toContainText("\u2039");
  const states = page.locator(".states-card .state-card"); await expect(states).toHaveCount(3);
  await expect(page.locator(".next-step").getByRole("button", { name: ar.shell.inbox.receive, exact: true })).toBeVisible();
  await expect(page.locator(".next-step").getByRole("button", { name: ar.review.open, exact: true })).toBeVisible();
  const main = (await page.locator(".material-main").boundingBox())!, side = (await page.locator(".material-side").boundingBox())!; expect(main.x).toBeGreaterThan(side.x);
  expect(await page.locator("main").textContent()).not.toMatch(/\b(lat|lon|latitude|longitude|gps)\b|31\.\d{3,}/i);
  await page.screenshot({ path: ".artifacts/material-w2-ar.png" });
  await page.goto("/en/materials/20000000-0000-4000-8000-000000000005"); await expect(page.locator(".breadcrumb-sep")).toHaveCSS("transform", "none");
  // حقل الحساسية الغائب يُقرأ «غير معروف» لا «لم يُوسَم».
  await page.route("**/api/bff/materials/20000000-0000-4000-8000-000000000005", async route => { const response = await route.fetch(), data = await response.json(); delete data.sensitivity; await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.getByTestId("sensitivity-line")).toContainText(en.shell.material.sensitivityUnknown); await expect(page.getByTestId("sensitivity-line")).toContainText(en.shell.material.unknownRule); await expect(page.getByTestId("sensitivity-line")).not.toContainText(en.shell.material.notSensitive);
});

test("on a phone the material's primary actions stay pinned above the bottom bar (M2)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await page.goto("/ar/materials/20000000-0000-4000-8000-000000000005");
  const actions = page.getByTestId("next-actions"), bar = page.getByRole("navigation", { name: ar.shell.bottomNav });
  await expect(actions).toHaveCSS("position", "sticky"); expect((await page.locator(".next-step-info h2").boundingBox())!.y).toBeLessThan((await page.locator(".reservation-state").boundingBox())!.y); await expect(actions.getByRole("button", { name: ar.shell.inbox.receive, exact: true })).toBeInViewport();
  const pinned = async () => { const box = (await actions.boundingBox())!, top = (await bar.boundingBox())!.y, gap = top - (box.y + box.height); return gap >= 0 && gap <= 16 && box.y > 844 / 2 && box.width >= 390 - 2 * 16 - 1; };
  expect(await page.evaluate(() => window.scrollY)).toBe(0); expect(await pinned()).toBe(true);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1 && window.scrollY > 844)).toBe(true);
  expect(await pinned()).toBe(true); await page.evaluate(() => window.scrollTo(0, 0)); await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  for (const button of await actions.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: ".artifacts/material-m2-ar.png" });
  // فشل «استلام» من الشريط المثبَّت يظهر بجانب أزراره، لا في البطاقة خارج الرؤية.
  await page.route("**/api/bff/materials/*/transitions", route => route.request().method() === "POST" ? route.fulfill({ status: 412, json: { code: "precondition_failed" } }) : route.continue());
  await actions.getByRole("button", { name: ar.shell.inbox.receive, exact: true }).click();
  const alert = actions.getByRole("alert"); await expect(alert).toHaveText(ar.review.changed); await expect(alert).toBeInViewport();
});
