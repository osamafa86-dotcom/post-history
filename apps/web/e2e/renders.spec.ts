import { expect, test, type Page, type Route } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

// نسخ قالبَي المتداول («مواد متداولة» ADR 0091، و«الشاهد» ADR 0110؛ C1–C12): نقاط النسخ في الـBFF مُحاكاة في المتصفح، والمادة
// بنص محايد وحده.
const id = "20000000-0000-4000-8000-000000000002", fileId = "70000000-0000-4000-8000-000000000001", signed = "/__render-copy?signature=synthetic";
const base = { material_id: id, material_version: 1, source_file_id: "50000000-0000-4000-8000-000000000002", template: "circulated", title_lines: ["عنوان تجريبي"], show_location: true, location_text: "مدينة، محافظة", label: "none", file_id: null, failure_reason: null, requested_by: "10000000-0000-4000-8000-000000000001", requested_at: "2026-11-03T14:50:00Z", started_at: null, completed_at: null };
const row = (n: number, patch: Record<string, unknown>) => ({ ...base, id: `60000000-0000-4000-8000-00000000000${n}`, ...patch });
const four = () => [
  row(1, { aspect: "vertical", state: "ready", file_id: fileId, started_at: "2026-11-03T14:51:00Z", completed_at: "2026-11-03T14:52:00Z" }),
  row(2, { aspect: "horizontal", state: "rendering", started_at: "2026-11-03T14:55:00Z" }),
  row(3, { aspect: "square", state: "requested" }),
  row(4, { aspect: "vertical", state: "failed", label: "circulated_footage", failure_reason: "title_overflow", title_lines: ["عنوان تجريبي طويل"], completed_at: "2026-11-03T14:56:00Z" }),
];
type Mock = { items: Record<string, unknown>[]; gets: number; posts: { key: string | null; body: Record<string, unknown> }[]; reply?: (route: Route) => Promise<void> };
test.use({ timezoneId: "UTC" });

async function login(page: Page, role = "reviewer", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click(); await expect(page.getByTestId("material-row")).toHaveCount(50);
}
async function setup(page: Page, items: Record<string, unknown>[], material: Record<string, unknown> = {}) {
  const mock: Mock = { items, gets: 0, posts: [] };
  await page.route(`**/api/bff/materials/${id}`, async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, title: "عنوان تجريبي", city: "مدينة", governorate: "محافظة", sensitivity: { minors: false, injured: false, graphic: false }, ...material } });
  });
  await page.route(`**/api/bff/materials/${id}/renders`, async route => {
    if (route.request().method() === "GET") { mock.gets++; return route.fulfill({ json: { items: mock.items } }); }
    mock.posts.push({ key: route.request().headers()["idempotency-key"] ?? null, body: route.request().postDataJSON() });
    if (mock.reply) return mock.reply(route);
    const created = row(9, { ...route.request().postDataJSON(), location_text: route.request().postDataJSON().show_location ? "مدينة، محافظة" : null, state: "requested" });
    mock.items = [created, ...mock.items]; return route.fulfill({ status: 202, json: created });
  });
  return mock;
}
const open = async (page: Page, locale: "ar" | "en" = "ar") => { await page.goto(`/${locale}/materials/${id}`); await expect(page.getByTestId("render-files")).toBeVisible(); };
const action = (page: Page, m = ar) => page.getByTestId("render-files").getByRole("button", { name: m.derivative.template.action, exact: true });
const downloadName = (m: typeof ar | typeof en, aspect: "vertical" | "horizontal" | "square", template: "circulated" | "witness" = "circulated") =>
  m.derivative.row.downloadAria.replace("{template}", m.derivative.templates[template]).replace("{aspect}", m.derivative.row.aspect[aspect]);

test("feature off (404) or a role outside the request roles hides the whole render UI", async ({ page }) => {
  await login(page);
  const listed = page.waitForResponse(r => r.url().endsWith(`/materials/${id}/renders`));
  await page.goto(`/ar/materials/${id}`); expect((await listed).status()).toBe(404);
  await expect(page.getByRole("heading", { name: ar.shell.material.states, exact: true })).toBeVisible();
  await expect(page.getByTestId("render-files")).toHaveCount(0); await expect(page.getByRole("button", { name: ar.derivative.template.action })).toHaveCount(0);
  await page.context().clearCookies();
  await login(page, "admin", "en"); const mock = await setup(page, four());
  await page.goto(`/en/materials/${id}`); await expect(page.getByRole("heading", { name: en.shell.material.states, exact: true })).toBeVisible();
  await expect(page.getByTestId("render-files")).toHaveCount(0); expect(mock.gets).toBe(0);
});

test("the four states, a click-time download link and polling that stops", async ({ page }) => {
  await login(page); await page.clock.install(); const mock = await setup(page, four());
  let links = 0;
  await page.route(`**/api/bff/materials/${id}/files/${fileId}/download-url`, route => { links++; return route.fulfill({ json: { url: signed, expires_at: new Date(Date.now() + 300000).toISOString() } }); });
  await page.route("**/__render-copy*", route => route.fulfill({ body: "synthetic", headers: { "Content-Type": "video/mp4", "Content-Disposition": "attachment" } }));
  await open(page); const rows = page.getByTestId("render-row"), d = ar.derivative;
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText(d.state.ready); await expect(rows.nth(0)).toContainText("14:52"); await expect(rows.nth(0)).toContainText(d.row.internalUse); await expect(rows.nth(0)).toContainText(d.row.rightsUnknown);
  const bar = rows.nth(1).getByRole("progressbar", { name: d.row.renderingAria }); await expect(bar).toBeVisible(); expect(await bar.getAttribute("aria-valuenow")).toBeNull();
  await expect(rows.nth(1)).toContainText(d.state.rendering); await expect(rows.nth(1)).toContainText("14:55");
  await expect(rows.nth(2)).toContainText(d.state.requested); await expect(rows.nth(2)).toContainText(d.row.requestedSub);
  await expect(rows.nth(3)).toContainText(d.state.failed); await expect(rows.nth(3)).toContainText(d.failure.title_overflow);
  expect(await page.locator(`[href*="signature"], [src*="signature"]`).count()).toBe(0); expect(links).toBe(0);
  const download = page.waitForEvent("download");
  await rows.nth(0).getByRole("button", { name: downloadName(ar, "vertical"), exact: true }).click(); await download; expect(links).toBe(1);
  // الاستطلاع كل عشر ثوانٍ ما دامت نسخة غير منتهية، ويقف حين لا تبقى.
  const before = mock.gets; await page.clock.runFor(10500); await expect.poll(() => mock.gets).toBe(before + 1);
  mock.items = mock.items.map(item => (["rendering", "requested"].includes(String(item.state)) ? { ...item, state: "ready", file_id: fileId, completed_at: "2026-11-03T15:00:00Z" } : item));
  await page.clock.runFor(10500); await expect.poll(() => mock.gets).toBe(before + 2); await expect(page.getByRole("progressbar")).toHaveCount(0);
  await page.clock.runFor(40000); expect(mock.gets).toBe(before + 2);
  // «طلب جديد» يعيد فتح الحوار بمعاملات الفاشلة.
  await rows.nth(3).getByRole("button", { name: d.newRequest, exact: true }).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: d.template.lineNumber.replace("{n}", "1"), exact: true })).toHaveValue("عنوان تجريبي طويل");
  await expect(dialog.getByRole("radio", { name: d.template.labelWith })).toBeChecked(); await expect(dialog.getByRole("radio", { name: d.template.aspect.vertical })).toBeChecked();
  await page.screenshot({ path: ".artifacts/renders-ar.png", fullPage: true });
});

test("request: code-point counter, required label, sensitive location default and an idempotent body without location text", async ({ page }) => {
  await login(page); const mock = await setup(page, [], { sensitivity: { minors: false, injured: true, graphic: false } }), t = ar.derivative.template;
  await open(page); await action(page).click(); const dialog = page.getByRole("dialog", { name: t.title });
  const line = (n: number) => dialog.getByRole("textbox", { name: t.lineNumber.replace("{n}", String(n)), exact: true }), submit = dialog.getByRole("button", { name: t.submit, exact: true });
  await expect(line(1)).toHaveValue("عنوان تجريبي"); await expect(dialog.getByTestId("line-count").first()).toHaveText("12/22");
  const location = dialog.getByRole("switch", { name: t.showLocation }); await expect(location).not.toBeChecked();
  await expect(dialog).toContainText(t.locationOffSensitive); await expect(dialog).toContainText(t.noteSensitive); await expect(dialog).toContainText(t.chooseLabelFirst);
  await expect(dialog.getByRole("radio", { name: t.labelWith })).not.toBeChecked(); await expect(dialog.getByRole("radio", { name: t.labelNone })).not.toBeChecked(); await expect(submit).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: ar.derivative.templates.circulated })).toBeChecked();
  await line(2).fill("عنوان تجريبي طويل للمادة"); await expect(dialog.getByTestId("line-count").nth(1)).toHaveText("24/22"); await expect(line(2)).toHaveAttribute("aria-invalid", "true"); await expect(dialog).toContainText(ar.derivative.blocked.line);
  await dialog.getByRole("radio", { name: t.labelNone }).check(); await expect(submit).toBeDisabled();
  // 22 نقطة ترميز طولها بوحدات UTF-16 أكثر من 22 تُقبل.
  await line(2).fill("\u{1D49C}".repeat(22)); await expect(dialog.getByTestId("line-count").nth(1)).toHaveText("22/22"); await expect(submit).toBeEnabled(); await line(2).fill("");
  await dialog.getByText(t.showLocation, { exact: true }).click(); await expect(location).toBeChecked(); await expect(dialog).toContainText("«مدينة، محافظة»");
  await dialog.getByText(t.aspect.square, { exact: true }).click(); await expect(dialog.getByRole("radio", { name: t.aspect.square })).toBeChecked(); await expect(dialog.getByTestId("render-preview")).toHaveClass(/square/);
  await submit.click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mock.posts).toHaveLength(1); expect(mock.posts[0].key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(mock.posts[0].body).toEqual({ template: "circulated", aspect: "square", title_lines: ["عنوان تجريبي"], show_location: true, label: "none" }); expect(JSON.stringify(mock.posts[0].body)).not.toContain("مدينة");
  await expect(page.getByTestId("render-row")).toHaveCount(1); await expect(page.getByTestId("render-row").first()).toContainText(ar.derivative.row.requestedSub);
});

test("errors: not allowed with reasons, the duration only when sent, the queue limit and an unusable location", async ({ page }) => {
  await login(page); const mock = await setup(page, [], { editorial_state: "inbox" }), d = ar.derivative, t = d.template;
  const request = async (reply: (route: Route) => Promise<void>) => {
    mock.reply = reply; await action(page).click(); const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: t.labelNone }).check(); await dialog.getByRole("button", { name: t.submit, exact: true }).click(); return dialog;
  };
  await open(page);
  await request(route => route.fulfill({ status: 409, json: { code: "render_not_allowed", details: { failed: ["editorial_state", "source"] } } }));
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(action(page)).toBeDisabled();
  const blocked = page.getByTestId("render-blocked"); await expect(blocked).toContainText(d.blocked.editorial_state.replace("{state}", ar.states.editorial_state.inbox)); await expect(blocked).toContainText(d.blocked.source);
  await expect(blocked).not.toContainText(d.blocked.sourceDuration.split("{max}")[0]);
  await page.reload(); await expect(action(page)).toBeEnabled();
  await request(route => route.fulfill({ status: 409, json: { code: "render_not_allowed", details: { failed: ["source"], max_source_duration_ms: 300000 } } }));
  await expect(blocked).toContainText(`${d.blocked.sourceDuration.split("{max}")[0]}5 دقائق`);
  await page.reload();
  const dialog = await request(route => route.fulfill({ status: 422, json: { code: "render_location_unusable" } }));
  const location = dialog.getByRole("switch", { name: t.showLocation }); await expect(location).toBeDisabled(); await expect(location).not.toBeChecked(); await expect(dialog).toContainText(d.blocked.location);
  mock.reply = undefined; await dialog.getByRole("button", { name: t.submit, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mock.posts.at(-1)!.body.show_location).toBe(false); expect(mock.posts.at(-1)!.key).not.toBe(mock.posts.at(-2)!.key);
  await request(route => route.fulfill({ status: 409, json: { code: "render_limit_reached" } }));
  await expect(page.getByTestId("render-blocked")).toContainText(d.blocked.limit);
  // ثلاث غير منتهية في القائمة تمنع قبل الطلب، ورابط نسخة سقطت حقوقها يقول السبب.
  mock.items = [...four().slice(0, 3), row(5, { aspect: "square", state: "requested" })]; await page.reload();
  await expect(action(page)).toBeDisabled(); await expect(page.getByTestId("render-blocked")).toContainText(d.blocked.limit);
  await page.route(`**/api/bff/materials/${id}/files/${fileId}/download-url`, route => route.fulfill({ status: 409, json: { code: "render_not_allowed", details: { failed: ["rights_state"] } } }));
  await page.getByTestId("render-row").first().getByRole("button", { name: downloadName(ar, "vertical"), exact: true }).click();
  await expect(page.getByTestId("render-row").first().getByRole("alert")).toHaveText(d.blocked.rights_state);
});

test("phone sheet in English: LTR chrome, Arabic title lines and 44px touch targets", async ({ page }) => {
  await login(page, "reviewer", "en"); await page.setViewportSize({ width: 390, height: 844 }); await setup(page, four()); const t = en.derivative.template;
  await open(page, "en"); const card = page.getByTestId("render-files");
  expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
  for (const target of [card.getByRole("button", { name: downloadName(en, "vertical"), exact: true }), card.getByRole("button", { name: en.derivative.newRequest, exact: true }), action(page, en)]) {
    const box = (await target.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44);
  }
  await action(page, en).click(); const dialog = page.getByRole("dialog", { name: t.title }); await expect(dialog).toBeVisible();
  const sheet = (await dialog.boundingBox())!; expect(Math.round(sheet.y + sheet.height)).toBe(844); expect(Math.round(sheet.width)).toBe(390);
  await expect(dialog.getByRole("textbox", { name: t.lineNumber.replace("{n}", "1"), exact: true })).toHaveAttribute("dir", "rtl");
  for (const target of [dialog.getByRole("button", { name: t.close, exact: true }), dialog.locator(".label-option").first(), dialog.locator(".label-option").last(), dialog.locator(".switch-row"), dialog.getByRole("button", { name: t.submit, exact: true })]) {
    await target.scrollIntoViewIfNeeded(); expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".artifacts/renders-phone-en.png" });
});

// «الشاهد» (ADR 0110): القالب خيار في الحوار نفسه وفي الورقة، والطلب يحمله، والنسخ بقالبها في بطاقة الملفات.
const mixed = () => [
  row(1, { aspect: "vertical", state: "ready", file_id: fileId, started_at: "2026-11-03T14:51:00Z", completed_at: "2026-11-03T14:52:00Z" }),
  row(2, { template: "witness", aspect: "vertical", state: "ready", file_id: "70000000-0000-4000-8000-000000000002", started_at: "2026-11-03T14:53:00Z", completed_at: "2026-11-03T14:54:00Z" }),
  row(3, { template: "witness", aspect: "square", state: "failed", label: "circulated_footage", failure_reason: "title_overflow", title_lines: ["عنوان تجريبي طويل"], completed_at: "2026-11-03T14:56:00Z" }),
];

test("Witness at 1280: the template choice drives the preview and the body, and the files card groups copies by template", async ({ page }) => {
  await login(page); const mock = await setup(page, mixed()), d = ar.derivative, t = d.template;
  expect(page.viewportSize()?.width).toBe(1280);
  await open(page);
  const groups = page.getByTestId("render-template-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("data-template", "circulated"); await expect(groups.nth(1)).toHaveAttribute("data-template", "witness");
  await expect(groups.nth(0).getByRole("heading", { name: d.group.template.replace("{template}", d.templates.circulated) })).toBeVisible();
  await expect(groups.nth(1).getByRole("heading", { name: d.group.template.replace("{template}", d.templates.witness) })).toBeVisible();
  await expect(groups.nth(0).getByTestId("render-row")).toHaveCount(1); await expect(groups.nth(1).getByTestId("render-row")).toHaveCount(2);
  // اسم زرّ التنزيل يفرّق بين نسختين عموديتين بقالبيهما
  await expect(groups.nth(0).getByRole("button", { name: downloadName(ar, "vertical", "circulated"), exact: true })).toBeVisible();
  await expect(groups.nth(1).getByRole("button", { name: downloadName(ar, "vertical", "witness"), exact: true })).toBeVisible();
  // «طلب جديد» من نسخة «الشاهد» الفاشلة يعيد الحوار على «الشاهد» ومعاملاتها
  await groups.nth(1).getByRole("button", { name: d.newRequest, exact: true }).click();
  let dialog = page.getByRole("dialog", { name: t.title });
  await expect(dialog.getByRole("radio", { name: d.templates.witness })).toBeChecked(); await expect(dialog.getByRole("radio", { name: t.aspect.square })).toBeChecked();
  await expect(dialog).toContainText(t.witnessTitleHint); await expect(dialog.getByTestId("render-preview")).toHaveClass(/witness/);
  await dialog.getByRole("button", { name: t.cancel, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  // طلب جديد: يُفتح على «مواد متداولة»، ثم «الشاهد» يبدّل المعاينة ويُرسل في الجسم وحده
  await action(page).click(); dialog = page.getByRole("dialog", { name: t.title });
  const preview = dialog.getByTestId("render-preview");
  await expect(dialog.getByRole("radio", { name: d.templates.circulated })).toBeChecked(); await expect(preview).toHaveClass(/circulated/); await expect(dialog).not.toContainText(t.witnessTitleHint);
  await dialog.getByText(d.templates.witness, { exact: true }).click();
  await expect(dialog.getByRole("radio", { name: d.templates.witness })).toBeChecked(); await expect(preview).toHaveClass(/witness/); await expect(preview.locator(".preview-corners i")).toHaveCount(4);
  await dialog.getByRole("radio", { name: t.labelWith }).check(); await expect(preview.locator(".preview-pill")).toHaveText(t.previewTag); await expect(preview.locator(".preview-tag")).toHaveCount(0);
  const options = dialog.locator(".template-option");
  for (let i = 0; i < 2; i++) { const box = (await options.nth(i).boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); }
  await dialog.getByRole("button", { name: t.submit, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mock.posts.at(-1)!.body).toEqual({ template: "witness", aspect: "vertical", title_lines: ["عنوان تجريبي"], show_location: true, label: "circulated_footage" });
  await expect(groups.nth(1).getByTestId("render-row")).toHaveCount(3); await expect(groups.nth(1).getByTestId("render-row").first()).toContainText(d.row.requestedSub);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: ".artifacts/renders-witness-1280.png", fullPage: true });
});

test("Witness at 375 in the phone sheet, Arabic then English: both templates reachable, 44px targets and no horizontal scroll", async ({ page }) => {
  for (const locale of ["ar", "en"] as const) {
    const m = locale === "ar" ? ar : en, d = m.derivative, t = d.template;
    await page.context().clearCookies(); await page.setViewportSize({ width: 1280, height: 720 }); await login(page, "reviewer", locale); await page.setViewportSize({ width: 375, height: 812 }); await setup(page, mixed());
    await open(page, locale); expect(await page.evaluate(() => document.documentElement.dir)).toBe(locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("render-template-group")).toHaveCount(2);
    await action(page, m).click(); const dialog = page.getByRole("dialog", { name: t.title }); await expect(dialog).toBeVisible();
    const sheet = (await dialog.boundingBox())!; expect(Math.round(sheet.width)).toBe(375); expect(Math.round(sheet.y + sheet.height)).toBe(812);
    const options = dialog.locator(".template-option");
    await expect(options).toHaveCount(2);
    for (let i = 0; i < 2; i++) { await options.nth(i).scrollIntoViewIfNeeded(); const box = (await options.nth(i).boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(375); }
    await dialog.getByText(d.templates.witness, { exact: true }).click(); await expect(dialog.getByRole("radio", { name: d.templates.witness })).toBeChecked();
    await expect(dialog.getByTestId("render-preview")).toHaveClass(/witness/); await expect(dialog).toContainText(t.witnessTitleHint);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `.artifacts/renders-witness-375-${locale}.png` });
    await dialog.getByRole("button", { name: t.close, exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  }
});
