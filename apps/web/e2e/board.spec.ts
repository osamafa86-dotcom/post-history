import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
async function login(page: Page, email: string, locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill(email); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
}
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

const columns = ["incoming", "checking", "ready", "stalled"] as const;

test("supervisor sees the four columns, counts, urgent and overdue tiles and receipts without leaked fields", async ({ page }) => {
  await login(page, "reviewer@example.test");
  await page.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: ar.board.title }).click();
  // Figma 193:862 وقرار المالك 2026-10-27: أربعة أعمدة بهذه الأسماء وهذا الترتيب (من البداية)، لا ستة.
  const list = page.getByRole("list", { name: ar.board.columnsLabel });
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(list.getByRole("heading", { level: 2 })).toHaveText(columns.map(c => new RegExp(`^${ar.board.columns[c]}`)));
  await expect(page.getByTestId("column-incoming").getByTestId("board-card")).toHaveCount(20);
  await expect(page.getByTestId("column-ready").getByTestId("board-card")).toHaveCount(1);
  await expect(page.getByTestId("column-stalled").getByTestId("board-card")).toHaveCount(1); await expect(page.getByTestId("column-checking").getByTestId("board-card")).toHaveCount(0);
  await expect(page.getByTestId("count-incoming")).toHaveText("198"); await expect(page.getByTestId("count-checking")).toHaveText("0");
  await expect(page.getByTestId("count-ready")).toHaveText("1"); await expect(page.getByTestId("count-stalled")).toHaveText("1");
  await expect(page.getByTestId("urgent-open")).toContainText("40"); await expect(page.getByTestId("overdue")).toContainText("2");
  await expect(page.getByText(ar.board.more)).toHaveCount(1);
  await expect(page.locator(".receipt-list li")).toHaveCount(3);
  await expect(page.getByTestId("upload-progress")).toHaveCount(1); await expect(page.getByTestId("upload-progress")).toContainText("25%");
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  await page.screenshot({ path: ".artifacts/board-desktop.png", fullPage: true });
});

test("states group into the four columns and the overlaps follow the documented priority (ADR 0078)", async ({ page, request }) => {
  await request.post(`${api}/__test/board-mix`);
  await login(page, "reviewer@example.test"); await page.goto("/ar/board");
  await expect(page.getByTestId("count-incoming")).toHaveText("188"); await expect(page.getByTestId("count-checking")).toHaveText("4");
  await expect(page.getByTestId("count-ready")).toHaveText("3"); await expect(page.getByTestId("count-stalled")).toHaveText("4");
  const title = (n: string) => `مادة اختبار اصطناعية ${n}`, has = (column: string, n: string) => page.getByTestId(`column-${column}`).getByText(title(n), { exact: true });
  await expect(has("checking", "004")).toHaveCount(1); await expect(has("checking", "006")).toHaveCount(1);          // اطّلع عليها، وقيد المراجعة
  await expect(has("checking", "007")).toHaveCount(1);                                                              // واردة والاستلام لم يبدأ
  await expect(has("checking", "008")).toHaveCount(1); await expect(has("ready", "008")).toHaveCount(0);            // مقبولة والتحقق الفني جارٍ: ليست جاهزة
  await expect(has("ready", "002")).toHaveCount(1); await expect(has("ready", "012")).toHaveCount(1); await expect(has("ready", "013")).toHaveCount(1);
  await expect(has("stalled", "003")).toHaveCount(1);                                                               // فشل فني
  await expect(has("stalled", "009")).toHaveCount(1); await expect(has("stalled", "010")).toHaveCount(1);            // تحتاج تعديلًا، ومرفوضة
  await expect(has("stalled", "011")).toHaveCount(1); await expect(has("ready", "011")).toHaveCount(0);            // مقبولة وفشل فني: متوقفة لا جاهزة
  await expect(page.getByText(title("014"), { exact: true })).toHaveCount(0);                                       // منشورة: خارج اللوحة
  await expect(page.getByTestId("urgent-open")).toBeVisible(); await expect(page.getByTestId("inbox-now")).toBeVisible();
  await page.goto("/ar/board?display=1");
  for (const [column, count] of [["incoming", "188"], ["checking", "4"], ["ready", "3"], ["stalled", "4"]]) await expect(page.getByTestId(`wall-column-${column}`).locator("h2 .wall-count")).toHaveText(count);
  await expect(page.locator(".wall-columns > section")).toHaveCount(4);
});

test("English board shows the four column names left to right", async ({ page }) => {
  await login(page, "reviewer@example.test", "en"); await page.goto("/en/board");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  const list = page.getByRole("list", { name: en.board.columnsLabel });
  await expect(list.getByRole("heading", { level: 2 })).toHaveText(columns.map(c => new RegExp(`^${en.board.columns[c]}`)));
  const first = await page.getByTestId("column-incoming").boundingBox(), last = await page.getByTestId("column-stalled").boundingBox();
  expect(first!.x).toBeLessThan(last!.x);
  await page.goto("/ar/board"); const arFirst = await page.getByTestId("column-incoming").boundingBox(), arLast = await page.getByTestId("column-stalled").boundingBox();
  expect(arFirst!.x).toBeGreaterThan(arLast!.x);
});

test("reporters do not see the board and the BFF refuses them", async ({ page }) => {
  await login(page, "reporter@example.test");
  await expect(page.getByRole("link", { name: ar.board.title })).toHaveCount(0);
  expect((await page.request.get("/api/bff/dashboard/newsroom")).status()).toBe(403);
  await page.goto("/ar/board"); await expect(page.getByText(ar.board.denied)).toBeVisible();
});

test("wall display: dark top bar with clock, dark by default, big tiles, four columns of eight and no leaked fields", async ({ page }) => {
  await login(page, "reviewer@example.test");
  await page.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: ar.board.title }).click();
  await page.getByRole("link", { name: ar.board.openDisplay }).click();
  await expect(page).toHaveURL(/\/ar\/board\?display=1$/);
  await expect(page.getByTestId("board-display")).toBeVisible();
  // Figma 193:865: شريط الشاشة الكبيرة بدل شريط مساحة العمل؛ بند واحد نشط (لوحة الإنتاج) والساعة والتاريخ في النهاية.
  await expect(page.locator(".topbar.workspace")).toBeHidden(); await expect(page.locator(".topbar.wall")).toBeVisible();
  const wallNav = page.locator(".topbar.wall").getByRole("navigation", { name: ar.workspace }); await expect(wallNav.getByRole("link")).toHaveCount(1); await expect(wallNav.getByRole("link", { name: ar.board.display.nav })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("wall-clock")).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  const brandBox = await page.locator(".topbar.wall .topbar-brand").boundingBox(), clockBox = await page.getByTestId("wall-clock").boundingBox(); expect(brandBox!.x).toBeGreaterThan(clockBox!.x);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByTestId("wall-urgent-open")).toContainText("40"); await expect(page.getByTestId("wall-urgent-open")).toHaveClass(/tone-urgent/);
  await expect(page.getByTestId("wall-overdue")).toContainText("2");
  await expect(page.locator(".wall-tiles")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator(".wall-columns > section")).toHaveCount(4);
  await expect(page.locator(".wall-columns h2")).toHaveText(columns.map(c => new RegExp(`^${ar.board.columns[c]}`)));
  await expect(page.getByTestId("wall-column-incoming").getByTestId("wall-card")).toHaveCount(8);
  await expect(page.getByTestId("wall-column-incoming").getByTestId("wall-card").first()).toHaveClass(/urgent/);
  await expect(page.getByTestId("wall-column-incoming")).toContainText(ar.board.display.more.replace("{n}", "190"));
  await expect(page.getByTestId("wall-column-checking")).toContainText(ar.board.display.empty);
  // Figma 193:862: دليل المسارات، رقم العمود الكبير بخط سفلي، وبطاقة بشريط داكن (إيصال وعمر) ولسان عاجل وخط مسارات وسطر محافظة.
  await expect(page.locator(".track-legend li")).toHaveCount(5); await expect(page.locator(".track-legend")).toContainText(ar.trackLine.legend);
  const head = page.getByTestId("wall-column-incoming").locator("h2"); await expect(head.locator(".wall-count")).toHaveText("198"); await expect(head).toHaveCSS("border-bottom-width", "2px");
  const card = page.getByTestId("wall-column-incoming").getByTestId("wall-card").first();
  const strip = await card.locator(".wall-slate").evaluate(el => { const i = document.createElement("i"); i.style.backgroundColor = "var(--vl-color-bg-slate)"; document.body.append(i); const slate = getComputedStyle(i).backgroundColor; i.remove(); return { strip: getComputedStyle(el).backgroundColor, slate }; });
  expect(strip.strip).toBe(strip.slate);
  await expect(card.locator(".wall-slate .wall-receipt")).toHaveText(/^RCPT-/); await expect(card.locator(".wall-priority.urgent")).toHaveText(ar.states.priority.urgent);
  await expect(card.getByTestId("track-line").locator(".track-seg")).toHaveCount(3); await expect(card.locator(".wall-place")).toHaveText(/\S/);
  await expect(page.locator(".wall-date")).toContainText(/\d{4}/);
  await expect(page.getByTestId("wall-upload")).toHaveCount(1); await expect(page.getByTestId("wall-upload")).toContainText("25%");
  await expect(page.getByTestId("wall-sound")).toContainText(ar.board.display.soundOff);
  await page.mouse.click(5, 5); await expect(page.getByTestId("wall-sound")).toContainText(ar.board.display.soundOn);
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: ".artifacts/board-wall-1920.png" });
  await page.getByRole("link", { name: ar.board.display.exit }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator(".topbar.workspace")).toBeVisible(); await expect(page.locator(".topbar.wall")).toHaveCount(0); await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
});

test("wall display goes stale and dims when the snapshot fails, and can be light", async ({ page }) => {
  await login(page, "reviewer@example.test");
  await page.goto("/ar/board?display=1&theme=light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("wall-urgent-open")).toContainText("40");
  await page.route("**/api/bff/dashboard/newsroom", route => route.fulfill({ status: 503, body: "{}" }));
  await expect(page.locator(".wall-banner.bad")).toContainText(ar.board.display.stale.split("{time}")[0].trim(), { timeout: 12000 });
  await expect(page.locator(".wall-body")).toHaveClass(/stale/);
});

test("ADR 0035 board and wall use server names and deadlines, tolerating null fields", async ({ page }) => {
  await login(page, "reviewer@example.test"); await page.goto("/ar/board");
  await expect(page.getByTestId("column-incoming")).toContainText(ar.board.reservedName.replace("{name}", "Synthetic staff"));
  await expect(page.getByTestId("ack-overdue")).toHaveCount(1);
  await expect(page.getByTestId("overdue")).toContainText(ar.board.oldestOverdue.split("{time}")[0]);
  await page.goto("/ar/board?display=1"); await expect(page.getByTestId("wall-column-incoming")).toContainText("Synthetic staff");
  await expect(page.getByTestId("wall-overdue")).toContainText(ar.board.oldestOverdue.split("{time}")[0]);
  await page.route("**/api/bff/materials?*", async route => { const response = await route.fetch(), data = await response.json(); for (const item of data.items) { item.reserved_by_name = null; item.acknowledgement_due_at = null; } await route.fulfill({ response, json: data }); });
  await page.route("**/api/bff/dashboard/newsroom", async route => { const response = await route.fetch(), data = await response.json(); data.oldest_overdue_acknowledgement_at = null; for (const item of data.reserved) item.reserved_by_name = null; await route.fulfill({ response, json: data }); });
  await page.reload(); await expect(page.getByTestId("wall-card")).not.toHaveCount(0); await expect(page.getByTestId("board-display")).not.toContainText("Synthetic staff");
  await expect(page.getByTestId("ack-overdue")).toHaveCount(0); await expect(page.getByTestId("wall-overdue")).not.toContainText(ar.board.oldestOverdue.split("{time}")[0]);
});

test("beyond the fetch cap the counts say 'and more' instead of landing in the wrong columns, and uploads overflow reads like the cards (ADR 0078)", async ({ page, request }) => {
  await request.post(`${api}/__test/board-cap`);
  await login(page, "reviewer@example.test"); await page.goto("/ar/board");
  // 560 مادة قيد الاستلام الفني (pending) والسقف 500: ما لم يُجلب لا يدخل «واردة» ولا «جاهزة»، والعدّاد حدّ أدنى بعلامة +.
  await expect(page.getByTestId("board-capped")).toContainText("500"); await expect(page.getByTestId("board-capped")).toBeVisible();
  await expect(page.getByTestId("count-checking")).toContainText("500+");
  const incoming = (await page.getByTestId("count-incoming").textContent())!;
  expect(incoming).toMatch(/\d+\+/); expect(Number(incoming.match(/\d+/)![0])).toBeLessThanOrEqual(198);
  await expect(page.getByTestId("count-stalled")).toBeVisible();
  await page.getByRole("link", { name: ar.board.openDisplay }).click();
  await expect(page.getByTestId("wall-capped")).toBeVisible();
  await expect(page.getByTestId("wall-column-checking").locator(".wall-count")).toContainText("500+");
  await expect(page.getByTestId("wall-upload")).toHaveCount(3);
  await expect(page.locator(".wall-now .wall-more")).toHaveText(ar.board.display.more.replace("{n}", "2"));
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
});
