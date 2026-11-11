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
  await expect(page).toHaveURL(/\/ar\/my-materials$/);
  await page.getByRole("link", { name: ar.upload.nav }).click();
  await expect(page.getByRole("heading", { name: ar.upload.title })).toBeVisible();
}
function camera(size: number, name = "A001C003_261021.MOV") { const buffer = randomBytes(size); return { file: { name, mimeType: "video/quicktime", buffer }, sha: createHash("sha256").update(buffer).digest("hex") }; }
const question = (page: Page, name = ar.upload.sensitivityQuestion) => page.getByRole("group", { name, exact: true });
/** كل ما في النموذج عدا النوع والوسوم وجواب الحساسية. */
async function fields(page: Page) {
  await page.getByLabel(ar.upload.titleLabel).fill("لقطات من بطاقة الكاميرا"); await page.getByLabel(ar.governorate, { exact: true }).fill("غزة"); await page.getByLabel(ar.upload.city).fill("دير البلح");
  await page.getByLabel("العنوان", { exact: false }).and(page.locator("#field-headline")).fill("لقطات خام");
  await page.locator("#field-category").selectOption("news"); await page.locator("#field-consent").selectOption("true");
}
async function tag(page: Page, text: string) { await page.getByLabel(ar.shell.material.tagEditor.add).fill(text); await page.getByRole("button", { name: ar.shell.material.tagEditor.addButton, exact: true }).click(); }
async function describe(page: Page) {
  await page.getByRole("group", { name: ar.upload.types }).getByRole("button", { name: ar.types.raw_footage, exact: true }).click();
  await fields(page); await tag(page, "كاميرا");
  await question(page).getByLabel(ar.no, { exact: true }).check();
  await page.getByRole("button", { name: ar.upload.start }).click();
}

test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });
// المواد التي أُنشئت هنا لا تبقى للملفات التالية (الوارد يتوقع 200 مادة اصطناعية).
test.afterAll(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("uploads a camera file in parts with a refreshed ingest token and a dropped connection, then shows the receipt", async ({ page, request }) => {
  const outgoing: string[] = []; page.on("request", r => outgoing.push(r.url()));
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  // أول PATCH يرده الحاجز بـ 401 (رمز منتهٍ) فيُطلب رمز جديد، والتالي يُقطع اتصاله بعد 64 KiB.
  await request.post(`${api}/__test/tus?reject_ingest=1&cut=1`);
  const { file, sha } = camera(3 * 1048576 + 4321);
  await page.getByLabel(ar.upload.choose).setInputFiles(file);
  await describe(page);
  await expect(page.getByTestId("upload-row")).toHaveAttribute("data-phase", "done", { timeout: 20000 });
  await expect(page.getByTestId("upload-receipt")).toHaveText(/^R-\d{6}-\d{6}$/);
  // الإيصال بطاقة لا سطر: رقمه وحجم الملف وأول بصمته التي حسبها المتصفح وطابقها الخادم، ومنها «رفع آخر»
  const card = page.getByTestId("upload-receipt-card"); await expect(card.getByRole("heading", { name: ar.upload.receiptTitle })).toBeVisible();
  await expect(card).toContainText(sha.slice(0, 8)); await expect(card).not.toContainText(sha.slice(0, 12)); await expect(card).toContainText("MB");
  await expect(page.getByTestId("upload-row").getByRole("button", { name: ar.upload.uploadAnother })).toBeVisible();
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

test("no material is created until the sensitivity question is answered: nothing is assumed, and «yes» asks each of the three", async ({ page, request }) => {
  const created = async () => ((await (await request.get(`${api}/__test/state`)).json()).writes as { path: string; method: string; body: Record<string, unknown> }[]).filter(w => w.path === "/v1/materials" && w.method === "POST");
  await login(page); await page.getByLabel(ar.upload.choose).setInputFiles(camera(70000).file); await fields(page);
  const start = page.getByRole("button", { name: ar.upload.start }), need = page.getByTestId("upload-need"), types = page.getByRole("group", { name: ar.upload.types });
  // لا نوع ولا جواب مسبق
  await expect(types.locator("[aria-pressed='true']")).toHaveCount(0); await expect(question(page).getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(start).toBeDisabled(); await expect(need).toHaveText(ar.upload.need.type);
  // حقل المقابلة في نموذج المكتب يظهر حين تُختار نوعًا ثانيًا، وما كُتب في النموذج قبل اختيار النوع باقٍ
  await types.getByRole("button", { name: ar.types.report, exact: true }).click(); await expect(page.locator("#field-interview_guest")).toHaveCount(0);
  await types.getByRole("button", { name: ar.types.interview, exact: true }).click(); await page.locator("#field-interview_guest").fill("ضيف اصطناعي");
  await expect(page.locator("#field-headline")).toHaveValue("لقطات خام");
  await expect(need).toHaveText(ar.upload.need.tags); await tag(page, "مؤتمر");
  await expect(start).toBeDisabled(); await expect(need).toHaveText(ar.upload.need.sensitivity);
  // Enter في حقل لا يرسل النموذج من وراء الزر المعطّل
  await page.getByLabel(ar.upload.titleLabel).press("Enter"); expect(await created()).toHaveLength(0);
  await question(page).getByLabel(ar.yes, { exact: true }).check();
  await expect(start).toBeDisabled(); await expect(need).toHaveText(ar.upload.need.followups);
  for (const flag of ["minors", "injured", "graphic"] as const) await expect(question(page, ar.upload.followups[flag]).getByRole("radio", { checked: true })).toHaveCount(0);
  await question(page, ar.upload.followups.minors).getByLabel(ar.yes, { exact: true }).check(); await question(page, ar.upload.followups.injured).getByLabel(ar.no, { exact: true }).check();
  await expect(start).toBeDisabled();
  await question(page, ar.upload.followups.graphic).getByLabel(ar.no, { exact: true }).check();
  await expect(need).toHaveCount(0); await start.click();
  await expect(page.getByTestId("upload-row")).toHaveAttribute("data-phase", "done", { timeout: 20000 });
  const [material, ...more] = await created(); expect(more).toHaveLength(0);
  expect(material.body).toMatchObject({ sensitivity: { minors: true, injured: false, graphic: false }, material_types: ["report", "interview"], tags: ["مؤتمر"] });
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

test("production staff upload from the desktop; other roles do not see it and the BFF refuses them", async ({ page }) => {
  await page.goto("/ar/login");
  await page.getByLabel(ar.email).fill("reviewer@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  await page.getByRole("link", { name: ar.upload.nav }).click();
  await page.getByLabel(ar.upload.choose).setInputFiles(camera(1048576 + 7, "C0002.MP4").file);
  await describe(page);
  await expect(page.getByTestId("upload-row")).toHaveAttribute("data-phase", "done", { timeout: 20000 });
  await page.getByRole("button", { name: new RegExp(`^${ar.shell.account}`) }).click(); await page.getByRole("button", { name: ar.logout }).click(); await expect(page).toHaveURL(/\/ar\/login/);
  await page.getByLabel(ar.email).fill("admin@example.test"); await page.getByLabel(ar.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(ar.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: ar.signIn, exact: true }).click();
  await expect(page.getByTestId("material-row")).toHaveCount(50);
  await expect(page.getByRole("link", { name: ar.upload.nav })).toHaveCount(0);
  await page.goto("/ar/upload"); await expect(page.getByText(ar.upload.reporterOnly)).toBeVisible();
  const refused = await page.request.post("/api/bff/uploads", { headers: { Origin: "http://127.0.0.1:3100", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID() }, data: {} });
  expect(refused.status()).toBe(403);
});

test("signing out and opening the sign-in page clear unfinished-upload records on a shared computer", async ({ page, request }, info) => {
  await login(page);
  const path = info.outputPath("A003C001.MOV"); writeFileSync(path, randomBytes(3 * 1048576));
  await request.post(`${api}/__test/tus?fail_patches=1000`);
  await page.getByLabel(ar.upload.choose).setInputFiles(path);
  await describe(page);
  await expect.poll(async () => (await uploads(page))[0]?.offset ?? 0).toBeGreaterThan(0);
  const count = () => page.evaluate(() => new Promise<number>(resolve => {
    const open = indexedDB.open("post-history-uploads", 1);
    open.onupgradeneeded = () => { open.result.createObjectStore("pending", { keyPath: "key" }); };
    open.onsuccess = () => { const all = open.result.transaction("pending").objectStore("pending").count(); all.onsuccess = () => { resolve(all.result); open.result.close(); }; };
  }));
  expect(await count()).toBe(1);
  // سجل يبقى من تبويب أُغلق دون خروج: صفحة الدخول تمحوه.
  await page.goto("/ar/inbox"); expect(await count()).toBe(1);
  await page.context().clearCookies(); await page.goto("/ar/login"); await expect(page.getByLabel(ar.email)).toBeVisible();
  await expect.poll(count).toBe(0);
  await request.post(`${api}/__test/tus`);
});

test("the upload center lists unfinished sessions from the server and cancels them there", async ({ page, request }, info) => {
  await login(page);
  const path = info.outputPath("A004C001.MOV"); writeFileSync(path, randomBytes(3 * 1048576));
  await request.post(`${api}/__test/tus?fail_patches=1000`);
  await page.getByLabel(ar.upload.choose).setInputFiles(path);
  await describe(page);
  await expect.poll(async () => (await uploads(page))[0]?.offset ?? 0).toBeGreaterThan(0);
  page.removeAllListeners("dialog"); page.on("dialog", dialog => void dialog.accept());
  await page.reload();
  await expect(page.getByTestId("pending-upload")).toHaveAttribute("data-resumable", "true");
  // سجل محلي ممسوح (جهاز آخر): الجلسة تظهر من الخادم بلا استئناف، وتُلغى منه.
  await page.evaluate(() => new Promise(resolve => { const r = indexedDB.deleteDatabase("post-history-uploads"); r.onsuccess = r.onerror = r.onblocked = resolve; }));
  await page.reload();
  await expect(page.getByTestId("pending-upload")).toHaveAttribute("data-resumable", "false");
  await expect(page.getByText(ar.upload.otherDevice)).toBeVisible();
  expect(await page.locator("body").textContent()).not.toContain("never-display-canary");
  await page.getByRole("button", { name: ar.upload.abort }).click();
  await expect(page.getByTestId("pending-upload")).toHaveCount(0);
  expect((await uploads(page))[0].state).toBe("failed");
  await request.post(`${api}/__test/tus`);
});
