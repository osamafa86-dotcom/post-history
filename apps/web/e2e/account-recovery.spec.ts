import { expect, test, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };

// استعادة الحساب بلا بريد ومفاتيح المرور (ADR 0107، 0108) على الخادم الاصطناعي. مراسم WebAuthn مُحاكاة في المتصفح: الأصل عنوان IP محلي
// لا يصلح معرّف طرف معتمد، والتحقق التشفيري في الخادم يغطيه اختبار الـAPI بمصادِق برمجي. القيم اصطناعية منخفضة الإنتروبيا.
const api = "http://127.0.0.1:3201", key = /^[0-9a-f-]{36}$/;
const seeded = "c2VlZGVkLXBhc3NrZXk", fresh = "bmV3LXBhc3NrZXk", unknown = "dW5rbm93bi1wYXNza2V5";
const fill = (template: string, values: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
async function login(page: Page, role = "admin", locale: "ar" | "en" = "ar") {
  const m = locale === "ar" ? ar : en;
  await page.goto(`/${locale}/login`); await page.getByLabel(m.email).fill(`${role}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456"); await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}
/** مصادِق مُحاكى: يعيد اعتمادًا بالمعرّف المعطى، أو يُلغى كما لو أغلق المستخدم نافذة المتصفح. */
async function authenticator(page: Page, id: string, mode: "ok" | "cancel" = "ok") {
  await page.addInitScript(([id, mode]) => {
    const bytes = (text: string) => new TextEncoder().encode(text).buffer;
    const raw = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - id.length % 4) % 4)), c => c.charCodeAt(0)).buffer;
    const credential = (response: object) => ({ id, rawId: raw, type: "public-key", authenticatorAttachment: "platform", response, getClientExtensionResults: () => ({}) });
    const refuse = () => { if (mode === "cancel") throw new DOMException("cancelled", "NotAllowedError"); };
    Object.defineProperty(navigator, "credentials", { configurable: true, value: {
      create: async () => { refuse(); return credential({ clientDataJSON: bytes("{}"), attestationObject: bytes("synthetic"), getTransports: () => ["internal"] }); },
      get: async () => { refuse(); return credential({ clientDataJSON: bytes("{}"), authenticatorData: bytes("synthetic"), signature: bytes("synthetic"), userHandle: null }); },
    } });
  }, [id, mode] as const);
}
async function writes(request: import("@playwright/test").APIRequestContext, path: string) {
  return ((await (await request.get(`${api}/__test/state`)).json()).writes as { path: string; key: string; body: Record<string, unknown> }[]).filter(w => w.path === path);
}
const alertIn = (page: Page) => page.locator(".login-card [role=alert]");
async function noSideScroll(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
test.beforeEach(async ({ request }) => { await request.post(`${api}/__test/reset`); });

test("P1 «forgot password» explains both ways without email; a backup code opens a request with one answer for any code", async ({ page, request }) => {
  await page.goto("/ar/login"); await page.getByTestId("forgot-link").click();
  await expect(page).toHaveURL(/\/ar\/forgot-password$/);
  await expect(page.getByRole("heading", { level: 1, name: ar.recovery.forgot.title })).toBeVisible();
  await expect(page.getByRole("heading", { name: ar.recovery.forgot.codeTitle })).toBeVisible(); await expect(page.getByRole("heading", { name: ar.recovery.forgot.adminTitle })).toBeVisible();
  await page.getByLabel(ar.recovery.forgot.email).fill("reporter@example.test"); await page.getByLabel(ar.recovery.forgot.code).fill("1234");
  await page.getByRole("button", { name: ar.recovery.forgot.submit }).click();
  await expect(page.getByText(ar.recovery.forgot.codeInvalid)).toBeVisible(); expect((await (await request.get(`${api}/__test/auth`)).json()).recoveryStarts).toBe(0);
  await page.getByLabel(ar.recovery.forgot.code).fill("abcd-efgh-2345"); await page.getByRole("button", { name: ar.recovery.forgot.submit }).click();
  await expect(page.getByTestId("forgot-sent")).toContainText(ar.recovery.forgot.sentTitle);
  expect((await (await request.get(`${api}/__test/auth`)).json()).recoveryStarts).toBe(1);
  await expect(page.getByLabel(ar.recovery.forgot.code)).toHaveCount(0);
  await page.screenshot({ path: ".artifacts/p1-forgot-ar.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto("/en/forgot-password");
  await expect(page.getByRole("heading", { level: 1, name: en.recovery.forgot.title })).toBeVisible(); await noSideScroll(page);
  await page.screenshot({ path: ".artifacts/p1-forgot-en-375.png", fullPage: true });
});

test("P1 signs in with a passkey, says so when it is cancelled, refused or off, and never asks for an email", async ({ page, browser, request }) => {
  await authenticator(page, seeded); await page.goto("/ar/login");
  await page.getByTestId("passkey-sign-in").click(); await expect(page).toHaveURL(/\/ar\/inbox/); await expect(page.getByRole("banner")).toBeVisible();
  const cancel = await browser.newPage(); await authenticator(cancel, seeded, "cancel"); await cancel.goto("/ar/login");
  await cancel.getByTestId("passkey-sign-in").click(); await expect(alertIn(cancel)).toHaveText(ar.signInPage.passkeyCancelled); await expect(cancel).toHaveURL(/\/ar\/login/);
  const stranger = await browser.newPage(); await authenticator(stranger, unknown); await stranger.goto("/en/login");
  await stranger.getByTestId("passkey-sign-in").click(); await expect(alertIn(stranger)).toHaveText(en.signInPage.passkeyFailed);
  await request.post(`${api}/__test/passkeys-off`); await stranger.getByTestId("passkey-sign-in").click(); await expect(alertIn(stranger)).toHaveText(en.signInPage.passkeyUnavailable);
  await stranger.setViewportSize({ width: 375, height: 812 }); await noSideScroll(stranger); await stranger.screenshot({ path: ".artifacts/p1-passkey-en-375.png", fullPage: true });
  await cancel.close(); await stranger.close();
});

test("Security lists passkeys, adds one after a password and code re-check, revokes with a confirmation, and shows backup codes once", async ({ page, request }) => {
  await authenticator(page, fresh); await login(page, "reviewer");
  await page.getByRole("button", { name: new RegExp(`^${ar.shell.account}`) }).click(); await page.getByTestId("menu-security").click();
  await expect(page.getByRole("heading", { level: 1, name: ar.security.title })).toBeVisible();
  const passkeys = page.getByTestId("passkeys");
  await expect(passkeys.getByRole("listitem")).toHaveCount(1); await expect(passkeys.getByRole("listitem")).toContainText("حاسوب المكتب"); await expect(passkeys.getByRole("listitem")).toContainText(ar.security.synced);
  const listed = await (await page.request.get("/api/bff/me/passkeys")).text(); expect(listed).not.toContain(seeded); expect(listed).not.toContain("credential_id");
  await page.getByTestId("add-passkey").click(); const form = page.getByTestId("passkey-form");
  await form.getByLabel(ar.security.password).fill("wrong-password"); await form.getByLabel(ar.security.totp).fill("123456"); await form.getByRole("button", { name: ar.security.continue }).click();
  await expect(form.getByRole("alert")).toHaveText(ar.security.stepUpFailed); await expect(page.getByRole("banner")).toBeVisible();
  await form.getByLabel(ar.security.password).fill("synthetic-password"); await form.getByLabel(ar.security.totp).fill("");
  await form.getByRole("button", { name: ar.security.continue }).click(); await expect(form.getByRole("alert")).toHaveText(ar.security.totpRequired);
  await form.getByLabel(ar.security.totp).fill("123456"); await form.getByLabel(ar.security.name).fill("هاتف العمل"); await form.getByRole("button", { name: ar.security.continue }).click();
  await expect(page.getByTestId("passkeys-notice")).toHaveText(ar.security.added); await expect(passkeys.getByRole("listitem")).toHaveCount(2);
  await expect(passkeys.getByRole("listitem").filter({ hasText: "هاتف العمل" })).toContainText(ar.security.neverUsed);
  const [added] = await writes(request, "/v1/me/passkeys"); expect(added.key).toMatch(key); expect(added.body.name).toBe("هاتف العمل"); expect(added.body).not.toHaveProperty("password");
  await passkeys.getByRole("listitem").filter({ hasText: "حاسوب المكتب" }).getByRole("button", { name: ar.security.revoke }).click();
  await expect(page.getByTestId("confirm-revoke-passkey")).toContainText(fill(ar.security.revokeEffect, { name: "حاسوب المكتب" }));
  await page.getByTestId("confirm-revoke-passkey").getByRole("button", { name: ar.security.revoke }).click();
  await expect(page.getByTestId("passkeys-notice")).toHaveText(ar.security.revoked); await expect(passkeys.getByRole("listitem")).toHaveCount(1);
  const codes = page.getByTestId("backup-codes");
  await expect(codes.getByTestId("codes-status")).toContainText(ar.security.codesNone);
  await codes.getByTestId("generate-codes").click(); await expect(page.getByTestId("confirm-generate-codes")).toContainText(ar.security.generateEffect);
  await page.getByTestId("confirm-generate-codes").getByRole("button", { name: ar.security.generate }).click();
  await expect(codes.getByTestId("codes-once").getByRole("listitem")).toHaveCount(10); await expect(codes.getByTestId("codes-once")).toContainText("SYNT-HETI-CODA");
  await page.screenshot({ path: ".artifacts/security-ar.png", fullPage: true });
  await codes.getByRole("button", { name: ar.security.codesDone }).click(); await expect(codes.getByTestId("codes-once")).toHaveCount(0);
  await expect(codes.getByTestId("codes-status")).toContainText("بقيت 10 رموز صالحة"); await expect(codes).not.toContainText("SYNT-HETI");
  await page.setViewportSize({ width: 375, height: 812 }); await noSideScroll(page); await page.screenshot({ path: ".artifacts/security-ar-375.png", fullPage: true });
});

test("A1 issues a one-time reset link after a confirmation with its effect, shows it once, and the holder sets a new password with it", async ({ page, browser, request }) => {
  await login(page, "admin", "en"); await page.getByRole("link", { name: en.admin.nav, exact: true }).click();
  const self = "مدير تجريبي ١"; await page.getByTestId("staff-row").filter({ hasText: self }).getByRole("button", { name: fill(en.admin.manage, { name: self }) }).click();
  await expect(page.getByTestId("issue-reset-link")).toBeDisabled(); await expect(page.getByTestId("reset-link-card")).toContainText(en.admin.resetLink.self);
  await page.getByRole("button", { name: en.admin.back }).click();
  const name = "مراسل تجريبي ١"; await page.getByTestId("staff-row").filter({ hasText: name }).getByRole("button", { name: fill(en.admin.manage, { name }) }).click();
  const card = page.getByTestId("reset-link-card");
  await card.getByLabel(en.admin.resetLink.reason).selectOption("lost_device"); await card.getByTestId("issue-reset-link").click();
  const dialog = page.getByTestId("confirm-reset-link"); await expect(dialog).toContainText(fill(en.admin.resetLink.effect, { name })); await expect(dialog).toContainText(en.admin.resetLink.reasons.lost_device);
  await dialog.getByRole("button", { name: en.cancel, exact: true }).click(); expect(await writes(request, "/v1/users/10000000-0000-4000-8000-000000000003/password-reset-links")).toHaveLength(0);
  await card.getByTestId("issue-reset-link").click(); await page.getByTestId("confirm-reset-link").getByRole("button", { name: en.admin.resetLink.issue }).click();
  const shown = page.getByTestId("admin-reset-link"); await expect(shown).toContainText(en.recovery.link.once);
  const link = (await shown.getByTestId("reset-link").textContent())!;
  expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3100\/en\/reset-password#token=synthetic-reset-token-\d{12}$/);
  const [write] = await writes(request, "/v1/users/10000000-0000-4000-8000-000000000003/password-reset-links"); expect(write.body).toEqual({ reason: "lost_device" }); expect(write.key).toMatch(key);
  await expect(page.locator(".account-head")).toContainText(en.admin.statuses.recovery);
  await page.screenshot({ path: ".artifacts/a1-reset-link-en.png", fullPage: true });
  await shown.getByRole("button", { name: en.recovery.link.done }).click(); await expect(page.getByTestId("admin-reset-link")).toHaveCount(0); await expect(page.locator("main")).not.toContainText("synthetic-reset-token");

  const holder = await browser.newPage(); await holder.goto(link);
  await expect(holder).toHaveURL(/\/en\/reset-password$/); await expect(holder.getByRole("heading", { level: 1, name: en.recovery.reset.title })).toBeVisible();
  await expect(holder.getByLabel(en.recovery.reset.token)).toHaveCount(0);
  await holder.getByLabel(en.recovery.reset.newPassword, { exact: true }).fill("a-new-synthetic-pass"); await holder.getByLabel(en.recovery.reset.repeatPassword, { exact: true }).fill("a-new-synthetic-pass");
  await holder.getByRole("button", { name: en.recovery.reset.submit }).click();
  await expect(holder.getByRole("heading", { level: 1, name: en.recovery.reset.totpTitle })).toBeVisible();
  await holder.getByLabel(en.recovery.reset.code).fill("123456"); await holder.getByRole("button", { name: en.recovery.reset.confirm }).click();
  await expect(holder).toHaveURL(/\/en\/inbox/); await holder.close();

  const again = await browser.newPage(); await again.goto(link); await again.getByLabel(en.recovery.reset.newPassword, { exact: true }).fill("a-new-synthetic-pass"); await again.getByLabel(en.recovery.reset.repeatPassword, { exact: true }).fill("a-new-synthetic-pass");
  await again.getByRole("button", { name: en.recovery.reset.submit }).click(); await expect(again.getByTestId("reset-invalid")).toContainText(en.recovery.reset.invalidTitle);
  await again.setViewportSize({ width: 375, height: 812 }); await noSideScroll(again); await again.screenshot({ path: ".artifacts/reset-invalid-en-375.png", fullPage: true }); await again.close();
});

test("A supervisor approves a recovery request from its notification with a note, sees the link once, and a second approval is refused", async ({ page, request }) => {
  await request.post(`${api}/__test/recovery-notice`); await login(page, "reviewer");
  await page.goto("/ar/notifications"); await page.getByTestId("notification").filter({ hasText: ar.shell.bell.kinds.account }).click();
  await page.getByRole("link", { name: ar.notice.open, exact: true }).click();
  await expect(page).toHaveURL(/\/ar\/recovery-requests\/70000000-0000-4000-8000-000000000001$/);
  await expect(page.getByRole("heading", { level: 1, name: ar.recovery.approve.title })).toBeVisible();
  const approve = page.getByTestId("approve-recovery"); await expect(approve).toBeDisabled();
  await page.getByLabel(ar.recovery.approve.note).fill("لقاء في المكتب"); await approve.click();
  await expect(page.getByTestId("confirm-approval")).toContainText(ar.recovery.approve.confirmEffect);
  await page.getByTestId("confirm-approval").getByRole("button", { name: ar.recovery.approve.confirm }).click();
  const shown = page.getByTestId("approval-reset-link"); await expect(shown.getByTestId("reset-link")).toHaveText(/\/ar\/reset-password#token=synthetic-reset-token-\d{12}$/);
  await page.screenshot({ path: ".artifacts/recovery-approval-ar.png", fullPage: true });
  await shown.getByRole("button", { name: ar.recovery.link.done }).click(); await expect(page.getByTestId("approval-done")).toHaveText(ar.recovery.approve.approved);
  expect((await (await request.get(`${api}/__test/auth`)).json()).requests["70000000-0000-4000-8000-000000000001"]).toBe("approved");
  await page.reload(); await page.getByLabel(ar.recovery.approve.note).fill("مرة ثانية"); await page.getByTestId("approve-recovery").click();
  await page.getByTestId("confirm-approval").getByRole("button", { name: ar.recovery.approve.confirm }).click();
  await expect(page.getByTestId("approval-error")).toHaveText(ar.recovery.approve.conflict); await expect(page.getByTestId("approval-reset-link")).toHaveCount(0);
  await page.goto("/ar/recovery-requests/70000000-0000-4000-8000-000000000002"); await page.getByLabel(ar.recovery.approve.note).fill("اتصال بالرقم المعروف");
  await page.getByTestId("approve-recovery").click(); await page.getByTestId("confirm-approval").getByRole("button", { name: ar.recovery.approve.confirm }).click();
  await expect(page.getByTestId("approval-error")).toHaveText(ar.recovery.approve.adminQuorum);
  await page.setViewportSize({ width: 375, height: 812 }); await noSideScroll(page);
});

test("A reporter cannot open the approval page", async ({ page }) => {
  await login(page, "reporter"); await page.goto("/ar/recovery-requests/70000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("no-access")).toContainText(ar.recovery.approve.denied); await expect(page.getByTestId("approve-recovery")).toHaveCount(0);
});
