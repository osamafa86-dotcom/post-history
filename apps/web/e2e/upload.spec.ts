import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import ar from "../messages/ar.json" with { type: "json" };
const api = "http://127.0.0.1:3201";
type State = { state: string; receipt: string | null; ingest_tokens: number; cuts?: number; length?: number; offset?: number; patches?: number; resent?: number }[];
const uploads = async (page: Page) => (await (await page.request.get(`${api}/__test/uploads`)).json()) as State;

async function login(page: Page) {
  await page.goto("/ar/login");
  await page.getByLabel(ar.email).fill("reporter@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.getByRole("link", { name: ar.upload.nav }).click();
  await expect(page.getByRole("heading", { name: ar.upload.title })).toBeVisible();
}
function camera(size: number, name = "A001C003_261021.MOV") { const buffer = randomBytes(size); return { file: { name, mimeType: "video/quicktime", buffer }, sha: createHash("sha256").update(buffer).digest("hex") }; }
async function describe(page: Page) {
  await page.getByLabel(ar.upload.titleLabel).fill("لقطات من بطاقة الكاميرا"); await page.getByLabel(ar.governorate, { exact: true }).fill("غزة"); await page.getByLabel(ar.upload.city).fill("دير البلح");
  await page.getByLabel("العنوان", { exact: false }).and(page.locator("#field-headline")).fill("لقطات خام");
  await page.locator("#field-category").selectOption("news"); await page.locator("#field-consent").selectOption("true");
  await page.getByRole("button", { name: ar.upload.start }).click();
}

test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("uploads a camera file in parts with a refreshed ingest token and a dropped connection, then shows the receipt", async ({ page, request }) => {
  const outgoing: string[] = []; page.on("request", r => outgoing.push(r.url()));
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  // أول PATCH يرده الحاجز بـ 401 (رمز منتهٍ) فيُطلب رمز جديد، والتالي يُقطع اتصاله بعد 64 KiB.
  await request.post(`${api}/__test/tus?reject_ingest=1&cut=1`);
  const { file } = camera(3 * 1048576 + 4321);
  await page.getByLabel(ar.upload.choose).setInputFiles(file);
  await describe(page);
  await expect(page.getByTestId("upload-row")).toHaveAttribute("data-phase", "done", { timeout: 20000 });
  await expect(page.getByTestId("upload-receipt")).toHaveText(/^R-\d{6}-\d{6}$/);
  const [state] = await uploads(page);
  // بعد القطع قد يصل PATCH بإزاحة قديمة فيرد 409 ويعيد العميل HEAD؛ ما يُحفظ بعدها يبدأ من إزاحة الخادم.
  expect(state).toMatchObject({ state: "verified", offset: file.buffer.length, length: file.buffer.length });
  expect(state.ingest_tokens).toBeGreaterThanOrEqual(2); expect(state.cuts).toBe(1);
  // الأصل تحقق على الخادم ببصمة SHA-256 التي حسبها المتصفح قبل الرفع (لا checksum_mismatch).
  await page.getByRole("link", { name: ar.upload.open }).click();
  await expect(page.locator("[data-track='technical_state']")).toBeVisible();
  await expect(page.locator(".metadata")).toContainText(state.receipt!);
  expect(outgoing.every(url => url.startsWith("http://127.0.0.1:3100/") || url.startsWith(`${api}/files/`))).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.screenshot({ path: ".artifacts/upload-desktop.png", fullPage: true });
});

test("resumes from the server offset after the tab is closed and the same file is chosen again", async ({ page, request, context }, info) => {
  await login(page);
  // ملف على القرص: إعادة اختياره تعطي الاسم والحجم ووقت التعديل نفسها، كما عند المستخدم.
  const file = { buffer: randomBytes(4 * 1048576 + 99) }, path = info.outputPath("A002C001.MXF"); writeFileSync(path, file.buffer);
  await request.post(`${api}/__test/tus?fail_patches=1000`);
  await page.getByLabel(ar.upload.choose).setInputFiles(path);
  await describe(page);
  await expect.poll(async () => (await uploads(page))[0]?.offset ?? 0).toBeGreaterThanOrEqual(1048576);
  const before = (await uploads(page))[0].offset!;
  // S10: سجل الاستئناف بلا رمز وبلا اسم الملف.
  const stored = await page.evaluate(() => new Promise<string>(resolve => { const open = indexedDB.open("post-history-uploads", 1); open.onsuccess = () => { const all = open.result.transaction("pending").objectStore("pending").getAll(); all.onsuccess = () => { resolve(JSON.stringify(all.result)); open.result.close(); }; }; }));
  expect(stored).toContain("client_sha256"); expect(stored).not.toContain("A002C001"); expect(stored).not.toMatch(/token/i);
  page.removeAllListeners("dialog"); page.on("dialog", dialog => void dialog.accept());
  await page.close({ runBeforeUnload: true });
  await request.post(`${api}/__test/tus`);
  const next = await context.newPage(); await next.goto("/ar/upload");
  await expect(next.getByTestId("pending-upload")).toHaveCount(1);
  await next.getByLabel(ar.upload.choose).setInputFiles(path);
  await expect(next.getByText(ar.upload.resumed)).toBeVisible();
  await expect(next.getByTestId("upload-row")).toHaveAttribute("data-phase", "done", { timeout: 20000 });
  const [state] = await uploads(next);
  // لا إعادة لما وصل: الإزاحة بعد الاستئناف تبدأ من ما سجّله الخادم، ولا PATCH بإزاحة خاطئة.
  expect(before).toBeGreaterThan(0); expect(state).toMatchObject({ state: "verified", offset: file.buffer.length, resent: 0 });
  await expect(next.getByTestId("pending-upload")).toHaveCount(0);
});

test("stops the upload when the login session is revoked and clears resumable state", async ({ page, request }) => {
  await login(page);
  await request.post(`${api}/__test/tus?fail_patches=1000`);
  await page.getByLabel(ar.upload.choose).setInputFiles(camera(3 * 1048576, "C0001.MP4").file);
  await describe(page);
  await expect.poll(async () => (await uploads(page))[0]?.offset ?? 0).toBeGreaterThan(0);
  await page.getByRole("button", { name: ar.upload.pause }).click();
  await expect(page.getByTestId("upload-row")).toHaveAttribute("data-phase", "paused");
  const offset = (await uploads(page))[0].offset;
  // الإبطال: البوابة ترد 403 بفحص حالة الجلسة، والـBFF يرد 401، فيتوقف الرفع ويخرج المستخدم.
  await request.post(`${api}/__test/tus`); await request.post(`${api}/__test/revoke`);
  await page.getByRole("button", { name: ar.upload.resume }).click();
  await expect(page).toHaveURL(/\/ar\/login\?reason=revoked/);
  await page.waitForTimeout(1000);
  expect((await uploads(page))[0].offset).toBe(offset);
  // لا سجل استئناف بعد الخروج.
  expect(await page.evaluate(() => new Promise<number>(resolve => {
    const open = indexedDB.open("post-history-uploads", 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("pending", { keyPath: "key" }); };
    open.onsuccess = () => { const count = open.result.transaction("pending").objectStore("pending").count(); count.onsuccess = () => { resolve(count.result); open.result.close(); }; };
  }))).toBe(0);
});

test("non-reporters do not see desktop upload and the BFF refuses them", async ({ page, request }) => {
  await page.goto("/ar/login");
  await page.getByLabel(ar.email).fill("reviewer@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  await expect(page.getByRole("link", { name: ar.upload.nav })).toHaveCount(0);
  await page.goto("/ar/upload"); await expect(page.getByText(ar.upload.reporterOnly)).toBeVisible();
  const refused = await page.request.post("/api/bff/uploads", { headers: { Origin: "http://127.0.0.1:3100", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID() }, data: {} });
  expect(refused.status()).toBe(403); void request;
});
