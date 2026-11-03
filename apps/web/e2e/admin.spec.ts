import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

// لوحة الإدارة v2 (A1–A6، ADR 0102) على الخادم الاصطناعي: القوائم من نقاط العقد وحدها، والتأكيد يقول الأثر، و412 يعيد التحميل ويقوله.
const api = "http://127.0.0.1:3201", key = /^[0-9a-f-]{36}$/;
const tagRow = (page: Page, tag: string) => page.getByTestId("tag-row").filter({ has: page.getByText(tag, { exact: true }) });
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
async function login(page: Page, role = "admin", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}
async function writes(request: import("@playwright/test").APIRequestContext, path: string) {
  return ((await (await request.get(`${api}/__test/state`)).json()).writes as { path: string; key: string; body: Record<string, unknown> }[]).filter(w => w.path === path);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("A1 lists staff from the contract without email, filters by role and status, searches email without showing it, and draws the role matrix", async ({ page }) => {
  await login(page); await page.getByRole("link", { name: ar.admin.nav, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: ar.admin.title })).toBeVisible();
  await expect(page.getByTestId("staff-row")).toHaveCount(12);
  await expect(page.getByTestId("staff-summary")).toContainText("12 مستخدمًا"); await expect(page.getByTestId("staff-summary")).toContainText("6 مراسلين");
  await expect(page.getByRole("button", { name: /دعوة|invite/i })).toHaveCount(0);
  const body = await (await page.request.get("/api/bff/users")).text(); expect(body).not.toContain("@"); expect(body).not.toContain("never-display-canary");
  await page.getByRole("button", { name: ar.admin.chips.suspended, exact: true }).click();
  await expect(page.getByTestId("staff-row")).toHaveCount(1); await expect(page.getByTestId("staff-row").getByTestId("staff-status")).toHaveText(ar.admin.statuses.suspended);
  await page.getByRole("button", { name: ar.admin.chips.producer, exact: true }).click(); await expect(page.getByTestId("staff-row")).toHaveCount(1); await expect(page.getByTestId("staff-row")).toContainText("مونتير تجريبي ١");
  await page.getByRole("button", { name: ar.admin.chips.all, exact: true }).click(); await page.getByRole("searchbox", { name: ar.admin.searchLabel }).fill("staff10@");
  await expect(page.getByTestId("staff-row")).toHaveCount(1); await expect(page.getByTestId("staff-row")).toContainText("مسؤول حقوق تجريبي"); await expect(page.locator("main")).not.toContainText("@");
  await page.getByRole("searchbox", { name: ar.admin.searchLabel }).fill("لا أحد بهذا الاسم"); await expect(page.getByTestId("staff-empty")).toBeVisible();
  await page.getByRole("button", { name: ar.admin.clearFilters }).click(); await expect(page.getByTestId("staff-row")).toHaveCount(12);
  const matrix = page.getByRole("region", { name: ar.admin.matrixTitle });
  await expect(matrix.getByRole("row", { name: new RegExp(ar.admin.capabilities.admin) }).getByText(ar.admin.can, { exact: true })).toHaveCount(1);
  await expect(matrix.getByRole("row", { name: new RegExp(ar.admin.capabilities.upload) }).getByText(ar.admin.can, { exact: true })).toHaveCount(4);
  await page.screenshot({ path: ".artifacts/a1-users-ar.png", fullPage: true });
});

test("A1 suspension says its effect, the suspended account shows so, and reactivation is offered", async ({ page, request }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.admin.nav, exact: true }).click();
  const name = "مراسل تجريبي ١"; await page.getByTestId("staff-row").filter({ hasText: name }).getByRole("button", { name: fill(en.admin.manage, { name }) }).click();
  await expect(page.getByRole("button", { name: en.admin.suspend, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: en.admin.suspend, exact: true }).click();
  await expect(page.getByTestId("confirm-account")).toContainText(fill(en.admin.suspendEffect, { name }));
  await page.getByTestId("confirm-account").getByRole("button", { name: en.cancel, exact: true }).click(); expect(await writes(request, "/v1/users/10000000-0000-4000-8000-000000000003/status")).toHaveLength(0);
  await page.getByRole("button", { name: en.admin.suspend, exact: true }).click(); await page.getByTestId("confirm-account").getByRole("button", { name: en.admin.confirm, exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: en.admin.suspended })).toBeVisible(); await expect(page.getByRole("button", { name: en.admin.activate, exact: true })).toBeVisible();
  const [write] = await writes(request, "/v1/users/10000000-0000-4000-8000-000000000003/status"); expect(write.body).toEqual({ status: "suspended" }); expect(write.key).toMatch(key);
  await page.getByRole("button", { name: en.admin.back }).click(); await expect(page.getByTestId("staff-row").filter({ hasText: name }).getByTestId("staff-status")).toHaveText(en.admin.statuses.suspended);
  const self = "مدير تجريبي ١"; await page.getByTestId("staff-row").filter({ hasText: self }).getByRole("button", { name: fill(en.admin.manage, { name: self }) }).click();
  await expect(page.getByRole("button", { name: en.admin.suspend, exact: true })).toBeDisabled(); await expect(page.getByText(en.admin.self, { exact: true })).toBeVisible();
});

test("A2 merges a reporter tag into its suggested twin after a confirmation that states how many materials change", async ({ page, request }) => {
  await login(page); await page.getByRole("link", { name: ar.tags.nav, exact: true }).click();
  await expect(page.getByTestId("tag-row")).toHaveCount(9);
  await expect(tagRow(page, "خيام")).toContainText(fill(ar.tags.sourceSuggested, { n: 5 }));
  const row = tagRow(page, "مياة");
  await expect(row).toContainText(ar.tags.sourceReporters);
  await row.getByRole("button", { name: fill(ar.tags.mergeIntoLabel, { tag: "مياة", target: "مياه" }) }).click();
  const dialog = page.getByTestId("rewrite-dialog");
  await expect(dialog.getByLabel(ar.tags.target, { exact: true })).toHaveValue("مياه");
  await expect(dialog.getByTestId("rewrite-effect")).toContainText(fill(ar.tags.effectMerge, { source: "مياة", target: "مياه", count: "4 مواد" }));
  await dialog.getByRole("button", { name: ar.cancel, exact: true }).click(); expect(await writes(request, "/v1/tag-rewrites")).toHaveLength(0);
  await row.getByRole("button", { name: fill(ar.tags.mergeIntoLabel, { tag: "مياة", target: "مياه" }) }).click();
  await dialog.getByRole("button", { name: ar.tags.confirmMerge, exact: true }).click();
  await expect(page.getByTestId("tags-notice")).toHaveText(fill(ar.tags.doneMerge, { source: "مياة", target: "مياه", count: "4 مواد" }));
  await expect(tagRow(page, "مياة")).toHaveCount(0);
  await expect(tagRow(page, "مياه")).toContainText("34");
  const [write] = await writes(request, "/v1/tag-rewrites"); expect(write.body).toEqual({ source: "مياة", target: "مياه" }); expect(write.key).toMatch(key);
  const school = tagRow(page, "مدارس");
  await school.getByRole("button", { name: fill(ar.tags.rewriteLabel, { tag: "مدارس" }) }).click();
  await dialog.getByLabel(ar.tags.target, { exact: true }).fill("مدارس ابتدائية");
  await expect(dialog.getByTestId("rewrite-effect")).toContainText(fill(ar.tags.effectRename, { source: "مدارس", target: "مدارس ابتدائية", count: "0 مادة" }));
  await expect(dialog).toContainText(fill(ar.tags.effectSuggested, { source: "مدارس", target: "مدارس ابتدائية" }));
  await dialog.getByRole("button", { name: ar.tags.confirmRename, exact: true }).click();
  await expect(page.getByTestId("tags-notice")).toHaveText(fill(ar.tags.doneRename, { source: "مدارس", target: "مدارس ابتدائية", count: "0 مادة" }));
  await expect(page.getByTestId("suggestion").nth(5)).toContainText("مدارس ابتدائية");
  expect(await (await page.request.get("/api/bff/tags")).text()).not.toContain("never-display-canary");
  await page.screenshot({ path: ".artifacts/a2-tags-ar.png", fullPage: true });
});

test("A2 suggested list: add, reorder, remove and «suggest it» each send the whole list with If-Match; a stale version reloads and says so", async ({ page, request }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.tags.nav, exact: true }).click();
  const panel = page.getByTestId("suggestions"); await expect(panel.getByTestId("suggestion")).toHaveCount(6);
  await page.getByRole("button", { name: en.tags.newTag, exact: true }).click(); await expect(page.getByLabel(en.tags.addLabel)).toBeFocused();
  const added = page.waitForRequest(r => r.url().endsWith("/tag-suggestions") && r.method() === "PUT");
  await page.getByLabel(en.tags.addLabel).fill("وسم مضاف"); await panel.getByRole("button", { name: en.tags.add, exact: true }).click();
  expect((await added).headers()["if-match"]).toBe('"3"');
  await expect(panel.getByTestId("suggestion")).toHaveCount(7); await expect(page.getByTestId("tags-notice")).toHaveText(fill(en.tags.added, { tag: "وسم مضاف", version: 4 }));
  const moved = page.waitForRequest(r => r.url().endsWith("/tag-suggestions") && r.method() === "PUT");
  await panel.getByRole("button", { name: fill(en.tags.moveDown, { tag: "وسم تجريبي ١" }) }).click(); expect((await moved).headers()["if-match"]).toBe('"4"');
  await expect(panel.getByTestId("suggestion").first()).toContainText("وسم تجريبي ٢"); await expect(panel.getByTestId("suggestion").nth(1)).toContainText("وسم تجريبي ١");
  await panel.getByRole("button", { name: fill(en.tags.remove, { tag: "مدارس" }) }).click(); await expect(panel.getByTestId("suggestion")).toHaveCount(6);
  await tagRow(page, "خيمة").getByRole("button", { name: fill(en.tags.suggestLabel, { tag: "خيمة" }) }).click();
  await expect(panel.getByTestId("suggestion").last()).toContainText("خيمة");
  const bodies = (await writes(request, "/v1/tag-suggestions")).map(w => w.body.tags);
  expect(bodies).toEqual([
    ["وسم تجريبي ١", "وسم تجريبي ٢", "وسم تجريبي ٣", "مياه", "خيام", "مدارس", "وسم مضاف"],
    ["وسم تجريبي ٢", "وسم تجريبي ١", "وسم تجريبي ٣", "مياه", "خيام", "مدارس", "وسم مضاف"],
    ["وسم تجريبي ٢", "وسم تجريبي ١", "وسم تجريبي ٣", "مياه", "خيام", "وسم مضاف"],
    ["وسم تجريبي ٢", "وسم تجريبي ١", "وسم تجريبي ٣", "مياه", "خيام", "وسم مضاف", "خيمة"],
  ]);
  await page.getByLabel(en.tags.addLabel).fill("وسم مضاف"); await expect(panel.getByText(en.tags.duplicate, { exact: true })).toBeVisible();
  await request.post(`${api}/__test/admin-bump?what=tags`);
  await panel.getByRole("button", { name: fill(en.tags.remove, { tag: "خيام" }) }).click();
  await expect(page.getByTestId("tags-notice")).toHaveText(en.tags.listChanged);
  await expect(panel.getByTestId("suggestion").filter({ hasText: "وسم من جلسة أخرى" })).toHaveCount(1); await expect(panel.getByTestId("suggestion").filter({ hasText: "خيام" })).toHaveCount(1);
});

test("A6 saves the platform identity with If-Match, reloads a newer version on 412 and says so; fixed rules are words, not switches", async ({ page, request }) => {
  await login(page); await page.getByRole("link", { name: ar.settings.nav, exact: true }).click();
  const app = page.getByLabel(ar.settings.fields.app_name), save = page.getByRole("button", { name: ar.settings.save, exact: true });
  await expect(app).toHaveValue("ميدان بوست"); await expect(save).toBeDisabled();
  await app.fill("ميدان بوست التجريبي");
  const put = page.waitForRequest(r => r.url().endsWith("/platform-settings") && r.method() === "PUT"); await save.click(); const sent = await put;
  expect(sent.headers()["if-match"]).toBe('"1"'); expect(sent.headers()["idempotency-key"]).toMatch(key);
  expect(sent.postDataJSON()).toEqual({ platform_name: "المكتبة المرئية", app_name: "ميدان بوست التجريبي", watermark_text: "معاينة · المكتبة المرئية" });
  await expect(page.getByTestId("settings-notice")).toHaveText(fill(ar.settings.saved, { version: 2 }));
  await request.post(`${api}/__test/admin-bump?what=platform`);
  await app.fill("اسم آخر"); await save.click();
  await expect(page.getByTestId("settings-notice")).toHaveText(ar.settings.changed); await expect(app).toHaveValue("ميدان بوست التجريبي ٢");
  await app.fill(" "); await expect(save).toBeDisabled(); await expect(app).toHaveAttribute("aria-invalid", "true");
  const fixed = page.getByRole("region", { name: ar.settings.fixedTitle });
  await expect(fixed.getByRole("switch")).toHaveCount(0); await expect(fixed.getByRole("checkbox")).toHaveCount(0); await expect(fixed.getByText(ar.settings.always, { exact: true })).toHaveCount(2);
  await expect(page.getByText(/قبول الوسوم/)).toHaveCount(0);
  expect(await (await page.request.get("/api/bff/platform-settings")).text()).not.toContain("never-display-canary");
  await page.screenshot({ path: ".artifacts/a6-settings-ar.png", fullPage: true });
});

test("A6 alert rule switch sends the rule with «enabled» flipped and its revision; a stale revision reloads", async ({ page, request }) => {
  await login(page); await page.getByRole("link", { name: ar.rules.title, exact: true }).click();
  await page.getByRole("button", { name: ar.rules.new }).click(); await page.getByLabel(ar.rules.name).fill("قاعدة تجريبية"); await page.getByRole("button", { name: ar.rules.save }).click(); await expect(page.getByTestId("rule-row")).toHaveCount(1);
  await page.getByRole("link", { name: ar.settings.nav, exact: true }).click();
  const rule = page.getByTestId("rule-summary"); await expect(rule).toHaveCount(1); await expect(rule).toContainText(ar.rules.events["material.urgent_received"]);
  const toggle = rule.getByRole("switch", { name: fill(ar.settings.toggle, { name: "قاعدة تجريبية" }) }); await expect(toggle).toBeChecked();
  const put = page.waitForRequest(r => /\/notification-rules\/[0-9a-f-]{36}$/.test(r.url()) && r.method() === "PUT"); await toggle.click(); const sent = await put;
  expect(sent.headers()["if-match"]).toBe('"1"'); expect(sent.postDataJSON().enabled).toBe(false);
  await expect(toggle).not.toBeChecked(); await expect(page.getByRole("status").filter({ hasText: fill(ar.settings.ruleOff, { name: "قاعدة تجريبية" }) })).toBeVisible();
  await request.post(`${api}/__test/bump-rule`); await toggle.click();
  await expect(page.getByRole("alert").filter({ hasText: ar.settings.ruleChanged })).toBeVisible(); await expect(toggle).not.toBeChecked();
});

test("A4 shows the month's earnings: cards from the same totals, the formula, readiness words, an export and an empty previous month", async ({ page }) => {
  await login(page); await page.getByRole("link", { name: ar.payouts.nav, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: ar.money.title })).toBeVisible();
  await expect(page.getByTestId("earnings-row")).toHaveCount(4);
  await expect(page.getByTestId("kpi-share")).toContainText("1,215.00"); await expect(page.getByTestId("kpi-ready")).toContainText("1,015.20");
  await expect(page.getByTestId("money-formula")).toContainText("30%");
  await expect(page.getByTestId("readiness")).toHaveText([ar.money.readiness.ready, ar.money.readiness.ready, ar.money.readiness.in_payout, ar.money.readiness.below_minimum]);
  await expect(page.getByTestId("earnings-total")).toContainText("4,500.00"); await expect(page.getByTestId("earnings-total")).toContainText("4,050.00");
  await expect(page.getByRole("button", { name: /صرف المحدد|صرف المحدّد/ })).toHaveCount(0); await expect(page.getByText(/بيانات الصرف ناقصة/)).toHaveCount(0);
  const report = await (await page.request.get(`/api/bff/contributor-earnings?month=${new Date().toISOString().slice(0, 7)}`)).text(); expect(report).not.toContain("@"); expect(report).not.toContain("never-display-canary");
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: ar.money.export }).click();
  expect((await download).suggestedFilename()).toMatch(/^money-\d{4}-\d{2}-USD\.csv$/);
  await expect(page.getByRole("button", { name: ar.money.monthNext })).toBeDisabled();
  await page.screenshot({ path: ".artifacts/a4-money-ar.png", fullPage: true });
  await page.getByRole("button", { name: ar.money.monthPrev }).click(); await expect(page.getByTestId("money-empty")).toBeVisible();
});

test("A5 shows each organization's purchases this year and activates a pending one after a confirmation; there is no reject", async ({ page, request }) => {
  await login(page); await page.getByRole("link", { name: ar.buyers.nav, exact: true }).click();
  await expect(page.getByTestId("organization-row")).toHaveCount(2);
  const active = page.getByTestId("organization-row").filter({ hasText: "شبكة الأخبار" });
  await expect(active.getByTestId("organization-purchases")).toContainText("8,420.00"); await expect(active.getByTestId("organization-purchases")).toContainText("12 طلبًا");
  const card = page.getByTestId("join-request"); await expect(card).toHaveCount(1); await expect(card).toContainText(fill(ar.buyers.joinTitle, { name: "مؤسسة أخرى" }));
  await expect(card.getByRole("button", { name: /رفض/ })).toHaveCount(0);
  await card.getByRole("button", { name: ar.buyers.activate, exact: true }).click();
  const dialog = page.getByTestId("confirm-activate"); await expect(dialog).toContainText(fill(ar.buyers.activateEffect, { name: "مؤسسة أخرى" }));
  const put = page.waitForRequest(r => r.url().endsWith("/buyer-organizations/90000000-0000-4000-8000-000000000002") && r.method() === "PUT");
  await dialog.getByRole("button", { name: ar.buyers.activate, exact: true }).click(); const sent = await put;
  expect(sent.headers()["if-match"]).toBe('"1"'); expect(sent.postDataJSON().status).toBe("active");
  await expect(page.getByTestId("join-request")).toHaveCount(0);
  await expect(page.getByTestId("organization-row").filter({ hasText: "مؤسسة أخرى" })).toContainText(ar.buyers.statuses.active);
  expect(await (await page.request.get(`/api/bff/buyer-purchase-totals?year=${new Date().getUTCFullYear()}`)).text()).not.toContain("@");
  expect((await writes(request, "/v1/buyer-organizations/90000000-0000-4000-8000-000000000002"))).toHaveLength(1);
  await page.screenshot({ path: ".artifacts/a5-buyer-orgs-ar.png", fullPage: true });
});

test("A3 builds on three panes: contract fields are fixed with «encrypted» on the place, a field added from the palette is edited beside the list", async ({ page }) => {
  await login(page); await page.goto("/ar/forms");
  await expect(page.getByRole("heading", { level: 1, name: fill(ar.formsAdmin.titleVersion, { title: ar.formsAdmin.titleV2, version: 1 }) })).toBeVisible();
  await expect(page.getByTestId("core-field")).toHaveCount(8); await expect(page.getByTestId("core-field").filter({ hasText: ar.formsAdmin.core.location.label })).toContainText(ar.formsAdmin.encrypted);
  await expect(page.getByRole("button", { name: fill(ar.formsAdmin.addType, { type: ar.formsAdmin.types.number }) })).toBeDisabled();
  await page.getByRole("button", { name: ar.formsAdmin.clone }).click();
  await expect(page.getByRole("heading", { level: 1, name: fill(ar.formsAdmin.titleDraft, { title: ar.formsAdmin.titleV2, version: 2 }) })).toBeVisible();
  await page.getByRole("button", { name: fill(ar.formsAdmin.addType, { type: ar.formsAdmin.types.number }) }).click();
  await expect(page.getByTestId("field-row").last()).toHaveAttribute("class", /selected/);
  await expect(page.getByTestId("field-editor").getByLabel(ar.formsAdmin.type, { exact: true })).toHaveValue("number");
  await expect(page.getByRole("button", { name: fill(ar.formsAdmin.addType, { type: ar.formsAdmin.types.location }) })).toBeDisabled();
  await expect(page.getByText(/يظهر في الإرسال العاجل|يُرسل إلى المتجر/)).toHaveCount(0);
});

test("the admin pages fit a 375 px phone without sideways scroll, with rows as cards and the money list as records (M5)", async ({ page }) => {
  test.setTimeout(90000); await page.setViewportSize({ width: 375, height: 812 }); await login(page);
  const wide: string[] = [];
  for (const path of ["admin", "tags", "forms", "payouts", "buyer-organizations", "settings"]) {
    await page.goto(`/ar/${path}`); await page.waitForLoadState("networkidle").catch(() => {});
    const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    if (scroll > width) wide.push(`${path} ${scroll}`);
  }
  expect(wide).toEqual([]);
  await page.goto("/ar/payouts"); const record = page.getByTestId("earnings-row").first();
  await expect(record.locator(".row-money")).toBeVisible(); await expect(record.locator(".row-sub")).toBeVisible(); await expect(page.getByTestId("earnings-row").first().locator("td.phone-hide").first()).toBeHidden();
  await page.screenshot({ path: ".artifacts/m5-money-phone.png", fullPage: true });
  await page.goto("/ar/admin"); await expect(page.getByTestId("staff-row").first()).toBeVisible(); await page.screenshot({ path: ".artifacts/a1-users-phone.png", fullPage: true });
});
