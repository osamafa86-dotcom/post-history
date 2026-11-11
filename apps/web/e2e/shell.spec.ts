import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import ar from "../messages/ar.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
type Locale = "ar" | "en";
const dict = { ar, en };
async function login(page: Page, who: string, locale: Locale) {
  const m = dict[locale];
  await page.goto(`/${locale}/login`);
  await page.getByLabel(m.email).fill(`${who}@example.test`); await page.getByLabel(m.password, { exact: true }).fill("synthetic-password"); await page.getByLabel(m.totp, { exact: true }).fill("123456");
  await page.getByRole("button", { name: m.signIn, exact: true }).click();
  await expect(page.getByRole("banner")).toBeVisible();
}
const probe = (page: Page, property: "backgroundColor" | "color", token: string) => page.evaluate(([p, t]) => { const i = document.createElement("i"); i.style[p as "color"] = `var(${t})`; document.body.append(i); const value = getComputedStyle(i)[p as "color"]; i.remove(); return value; }, [property, token]);
test.beforeEach(async ({ request }) => { await request.post("http://127.0.0.1:3201/__test/reset"); });

// هيكل v2 (W1، T1، M1؛ ADR 0085 وweb-v2.md): الشريط الجانبي في جهة البداية بثلاث مجموعات، والشريط العلوي بالبحث والجرس والحساب.
for (const locale of ["ar", "en"] as Locale[]) {
  const m = dict[locale];
  test(`the sidebar marks the current page on each main page (${locale})`, async ({ page }) => {
    await login(page, "reviewer", locale);
    const pages: [string, string][] = [["inbox", m.inbox], ["board", m.board.title], ["upload", m.upload.nav], ["notifications", m.notice.title], ["form-preview", m.formPreview]];
    for (const [path, label] of pages) {
      await page.goto(`/${locale}/${path}`);
      await expect(page.getByRole("banner")).toHaveClass(/topbar workspace/);
      const nav = page.getByRole("navigation", { name: m.workspace }); await expect(nav).toBeVisible();
      await expect(nav.locator("[aria-current='page']")).toHaveCount(1); await expect(nav.locator("[aria-current='page']")).toHaveAccessibleName(label);
      await expect(page.getByRole("main")).toHaveCount(1);
    }
    await expect(page.getByRole("navigation", { name: m.workspace }).getByText(m.shell.groups.newsroom, { exact: true })).toBeVisible();
  });
  test(`the sidebar sits on the start edge and the bar carries search, bell and account, in v2 tokens (${locale})`, async ({ page }) => {
    await login(page, "reviewer", locale);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const sidebar = (await page.getByTestId("sidebar").boundingBox())!, main = (await page.getByRole("main").boundingBox())!, width = page.viewportSize()!.width;
    if (locale === "ar") { expect(sidebar.x).toBeGreaterThan(main.x); expect(sidebar.x + sidebar.width).toBeGreaterThan(width - 2); } else { expect(sidebar.x).toBeLessThan(main.x); expect(sidebar.x).toBeLessThan(2); }
    expect(sidebar.width).toBe(240);
    const bar = page.getByRole("banner");
    await expect(bar.getByRole("searchbox", { name: m.inboxSearch.label })).toBeVisible();
    await expect(bar.getByRole("button", { name: m.shell.bell.open })).toBeVisible();
    // الألوان من رموز v2 الدلالية نفسها: سطح الشريط bg/raised والصفحة bg/base.
    expect(await bar.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await probe(page, "backgroundColor", "--v2-c-bg-raised"));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(await probe(page, "backgroundColor", "--v2-c-bg-base"));
    // الخطوط مستضافة على الأصل نفسه (CSP font-src 'self'): العنوان بـ Rubik والنص بـ Readex Pro.
    expect(await page.getByRole("heading", { level: 1 }).evaluate(el => getComputedStyle(el).fontFamily)).toMatch(/^"?Rubik/);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Readex Pro/);
    await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Readex Pro"') && document.fonts.check('700 22px "Rubik"'))).toBe(true);
    // نص العنصر النائب في البحث ≥ 4.5:1 على خلفية الحقل (الوضع الفاتح).
    const field = await bar.getByRole("searchbox").evaluate(el => [getComputedStyle(el, "::placeholder").color, getComputedStyle(el).backgroundColor]);
    expect(ratio(field[0], field[1])).toBeGreaterThanOrEqual(4.5);
    const account = bar.getByRole("button", { name: new RegExp(`^${m.shell.account}`) }); await account.click();
    await expect(page.getByTestId("topbar-user")).toHaveText(/\S/); await expect(page.getByTestId("topbar-user")).not.toContainText("@");
    await expect(page.getByRole("button", { name: m.logout, exact: true })).toBeVisible(); await expect(page.getByRole("link", { name: m.language, exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(page.getByRole("button", { name: m.logout, exact: true })).toHaveCount(0);
  });
  test(`buyer bar shows the store destinations and no staff pages, in the store's dark face (${locale})`, async ({ page }) => {
    await login(page, "buyer", locale);
    await expect(page).toHaveURL(new RegExp(`/${locale}/store$`));
    await expect(page.getByTestId("sidebar")).toHaveCount(0); await expect(page.getByTestId("bottombar")).toHaveCount(0);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-mode", "dark");
    const nav = page.getByRole("banner").getByRole("navigation", { name: m.workspace });
    await expect(nav.getByRole("link")).toHaveText([m.store.nav.materials, m.store.nav.licenses, m.store.nav.orders, m.buyers.myOrganization]);
    await expect(nav.locator("[aria-current='page']")).toHaveText(m.store.nav.materials);
    await expect(page.getByTestId("cart-chip")).toHaveAccessibleName(m.store.nav.cartCount.replace("{n}", "0"));
    await nav.getByRole("link", { name: m.store.nav.licenses }).click(); await expect(nav.locator("[aria-current='page']")).toHaveText(m.store.nav.licenses);
    await nav.getByRole("link", { name: m.buyers.myOrganization }).click(); await expect(nav.locator("[aria-current='page']")).toHaveText(m.buyers.myOrganization);
  });
}

test("the bell opens the notifications panel (W10): tabs all, mine and store, urgent first, mark all read and a link to the full page", async ({ page }) => {
  await login(page, "reviewer", "ar"); const t = ar.shell.bell;
  await page.getByRole("banner").getByRole("button", { name: t.open }).click();
  const panel = page.getByTestId("notifications-panel"); await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab")).toHaveText([new RegExp(`^${t.tabs.all}`), t.tabs.mine, t.tabs.store]);
  await expect(panel.getByTestId("bell-item")).toHaveCount(3); await expect(panel).not.toContainText("never-display-canary");
  await panel.getByRole("tab", { name: t.tabs.store }).click(); await expect(panel.getByRole("tab", { name: t.tabs.store })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: new RegExp(`^${t.tabs.all}`) }).click();
  await panel.getByRole("button", { name: t.readAll }).click(); await expect(panel.getByRole("button", { name: t.readAll })).toBeDisabled();
  await panel.getByRole("tab", { name: t.tabs.mine }).focus(); await page.keyboard.press("Escape"); await expect(panel).toHaveCount(0);
  await page.getByRole("banner").getByRole("button", { name: t.open }).click(); await page.getByTestId("notifications-panel").getByRole("link", { name: t.all }).click();
  await expect(page).toHaveURL(/\/ar\/notifications$/);
});

test("a tablet gets the icon rail with short labels and full names (T1)", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await login(page, "reviewer", "ar");
  const sidebar = page.getByTestId("sidebar"); expect((await sidebar.boundingBox())!.width).toBe(76);
  await expect(sidebar.getByRole("link", { name: ar.inbox, exact: true })).toBeVisible();
  await expect(sidebar.locator(".nav-short").first()).toBeVisible(); expect((await sidebar.locator(".nav-group-title").first().boundingBox())!.width).toBeLessThanOrEqual(1);
  for (const button of await page.getByTestId("material-row").first().getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a phone gets the bottom bar with five destinations and «more» holds the rest and the account (M1)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, "admin", "ar");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByTestId("sidebar")).not.toBeVisible();
  const bar = page.getByRole("navigation", { name: ar.shell.bottomNav }); await expect(bar).toBeVisible();
  await expect(bar.getByRole("listitem")).toHaveCount(5); await expect(bar.locator("[aria-current='page']")).toHaveAccessibleName(ar.inbox);
  for (const item of await bar.getByRole("listitem").all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await bar.getByRole("button", { name: ar.shell.more }).click();
  const sheet = page.locator("#more-sheet"); await expect(sheet.getByRole("button", { name: ar.logout, exact: true })).toBeVisible();
  await sheet.getByRole("link", { name: ar.admin.nav, exact: true }).click(); await expect(page).toHaveURL(/\/ar\/admin$/);
  await expect(bar.getByRole("button", { name: ar.shell.more })).toHaveAttribute("aria-current", "page");
});

test("a page outside the role says so, names the role and leads back (E5)", async ({ page }) => {
  await login(page, "reviewer", "ar"); await page.goto("/ar/payouts");
  const state = page.getByTestId("no-access"); await expect(state).toBeVisible();
  await expect(state.getByRole("alert")).toHaveText(ar.payouts.denied); await expect(state).toContainText(ar.shell.noAccess.title);
  await expect(page.getByTestId("sidebar").getByRole("link", { name: ar.payouts.nav })).toHaveCount(0);
  await state.getByRole("link", { name: ar.shell.noAccess.backInbox }).click(); await expect(page).toHaveURL(/\/ar\/inbox$/);
});

const luminance = (rgb: string) => { const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

/** الصفحات التي يتجاوز عرض مستندها عرض المنظر بعد اكتمال الخطوط؛ `shows` نص يجب أن يُرى في كل صفحة، فلا تمرّ صفحة لا تعرض ما يُختبر. */
async function sideways(page: Page, context: BrowserContext, locale: Locale, visits: [string | null, string[]][], shows?: string) {
  const wide: string[] = [];
  for (const [who, paths] of visits) {
    await context.clearCookies(); if (who) await login(page, who, locale);
    for (const path of paths) {
      await page.goto(`/${locale}/${path}`); await page.waitForLoadState("networkidle").catch(() => {});
      await page.evaluate(() => document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))));
      if (shows) await expect(page.getByText(shows).first(), path).toBeVisible();
      const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      if (scroll > width) wide.push(`${path} ${scroll}`);
    }
  }
  return wide;
}

// لا تمرير أفقي للصفحة على عرض 390 في أي صفحة، بالعربية والإنجليزية (ملاحظة المراجعة على /en/forms).
for (const locale of ["ar", "en"] as Locale[]) test(`no page scrolls sideways at 390px (${locale})`, async ({ page, context }) => {
  test.setTimeout(180000); await page.setViewportSize({ width: 390, height: 844 });
  const pages: [string | null, string[]][] = [
    [null, ["login", "privacy", "verify/PH-2026-7K3M9Q2XRT", "forgot-password", "reset-password"]],
    ["admin", ["inbox", "board", "notifications", "form-preview", "store", "store/licenses", "store/orders", "license-templates", "admin", "tags", "forms", "settings", "notification-rules", "buyer-organizations", "payouts", "commission-rules", "invite-conflicts", "security", "recovery-requests/70000000-0000-4000-8000-000000000001", "materials/20000000-0000-4000-8000-000000000001"]],
    ["reviewer", ["upload", "materials/20000000-0000-4000-8000-000000000005"]],
    ["reporter", ["my-materials", "earnings"]],
    ["buyer", ["store", "store/71000000-0000-4000-8000-000000000001", "store/licenses", "store/cart", "store/orders", "store/orders/92000000-0000-4000-8000-000000000001", "store/orders/92000000-0000-4000-8000-000000000001/invoice", "organization", "security"]],
  ];
  expect(await sideways(page, context, locale, pages)).toEqual([]);
});

// العنوان نص حرّ من 5 إلى 80 محرفًا: وسم بشرطات سفلية أو اسم ملف ملصوق لا مسافة فيه، فلا ينكسر عند كلمة. لا يوسّع صفحة الهاتف حيث يظهر.
const UNBROKEN_TITLE = "VID_20261019_093000_تغطية_ميدانية_بلا_مسافات_من_الميدان_final_v2";
for (const locale of ["ar", "en"] as Locale[]) test(`a title with no spaces does not widen the phone page (${locale})`, async ({ page, context, request }) => {
  test.setTimeout(120000); await page.setViewportSize({ width: 390, height: 844 });
  await request.post(`http://127.0.0.1:3201/__test/titles?title=${encodeURIComponent(UNBROKEN_TITLE)}`);
  expect(await sideways(page, context, locale, [
    ["reviewer", ["inbox", "materials/20000000-0000-4000-8000-000000000005"]],
    ["reporter", ["my-materials"]],
    ["buyer", ["store", "store/71000000-0000-4000-8000-000000000001", "store/orders/92000000-0000-4000-8000-000000000001", "store/licenses", "store/licenses/93000000-0000-4000-8000-000000000001"]],
  ], UNBROKEN_TITLE)).toEqual([]);
});

// هاتف باللمس كما يراه CSS: لا تحويم ومؤشّر خشن (`hover: none`، `pointer: coarse`).
test.describe("on a touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const background = (locator: Locator) => locator.evaluate(el => getComputedStyle(el).backgroundColor);

  /**
   * ما يخرج من حبر التسمية عن صندوق قصّها، بالبكسل، في كل جهة تقصّ فيها (صفر حيث لا قصّ). قياس هندسي لا لقطة: امتداد الحبر من مقاييس الخط
   * نفسه (`measureText`) حول خط الأساس وبداية النص كما وضعهما المتصفح، فلا يتغيّر بتغيّر رسم الحروف بين بيئة وأخرى.
   */
  const inkBeyondClip = (label: Locator) => label.evaluate(el => {
    const style = getComputedStyle(el), box = el.getBoundingClientRect(), range = document.createRange();
    range.selectNodeContents(el); const text = range.getBoundingClientRect();
    // خط الأساس: الحافة السفلى لعنصر inline-block فارغ يوضع في السطر نفسه
    const probe = document.createElement("span"); probe.style.cssText = "display:inline-block;inline-size:0;block-size:0"; el.append(probe);
    const baseline = probe.getBoundingClientRect().bottom; probe.remove();
    const pen = document.createElement("canvas").getContext("2d")!;
    pen.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`; pen.direction = style.direction as CanvasDirection; pen.textAlign = "left";
    const ink = pen.measureText(el.textContent!), inline = style.overflowX !== "visible", block = style.overflowY !== "visible";
    return {
      size: parseFloat(style.fontSize), drift: Math.abs(ink.width - text.width),
      beyond: { start: inline ? box.left - (text.left - ink.actualBoundingBoxLeft) : 0, end: inline ? text.left + ink.actualBoundingBoxRight - box.right : 0, above: block ? box.top - (baseline - ink.actualBoundingBoxAscent) : 0, below: block ? baseline + ink.actualBoundingBoxDescent - box.bottom : 0 },
    };
  });

  test("the bottom bar labels are set in the caption role and no part of a label is cut off", async ({ page }) => {
    await login(page, "reporter", "ar"); const bar = page.getByTestId("bottombar");
    // في شريط المراسل «موادي»: ياء أخيرة نقطتاها تحت السطر
    await expect(bar.locator(".nav-short", { hasText: ar.shell.short["my-materials"] })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const label of await bar.locator(".nav-short, .nav-more").all()) {
      const text = (await label.textContent())!, measured = await inkBeyondClip(label);
      expect(measured.size, text).toBeGreaterThanOrEqual(12);
      // القياس على النص نفسه بالخط نفسه: عرضه في الصفحة هو عرضه في القياس
      expect(measured.drift, text).toBeLessThan(0.5);
      for (const [side, beyond] of Object.entries(measured.beyond)) expect(beyond, `${text}: ink beyond the clip box, ${side}`).toBeLessThanOrEqual(0.05);
    }
  });

  test("fields are 16px or more, so the phone browser does not zoom the page when one takes focus", async ({ page, context }) => {
    const visits: [string | null, string[]][] = [[null, ["login", "forgot-password"]], ["reviewer", ["inbox", "upload", "notifications"]], ["reporter", ["earnings"]], ["admin", ["settings", "admin", "forms"]], ["buyer", ["store", "organization"]]];
    const small: string[] = [];
    for (const [who, paths] of visits) {
      await context.clearCookies(); if (who) await login(page, who, "ar");
      for (const path of paths) {
        await page.goto(`/ar/${path}`); await page.waitForLoadState("networkidle").catch(() => {});
        small.push(...await page.evaluate(at => [...document.querySelectorAll<HTMLElement>("input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), select, textarea")]
          .map(el => [el, parseFloat(getComputedStyle(el).fontSize)] as const).filter(([, size]) => size < 16).map(([el, size]) => `${at} ${el.tagName.toLowerCase()}[${el.getAttribute("name") ?? el.id}] ${size}px`), path));
      }
    }
    expect(small).toEqual([]);
  });

  test("no visible text is smaller than the caption role (12px) on the main pages", async ({ page, context }) => {
    const visits: [string, string[]][] = [["reviewer", ["inbox", "board", "notifications", "materials/20000000-0000-4000-8000-000000000005"]], ["reporter", ["my-materials", "earnings"]], ["buyer", ["store"]]];
    const small: string[] = [];
    for (const [who, paths] of visits) {
      await context.clearCookies(); await login(page, who, "ar");
      for (const path of paths) {
        await page.goto(`/ar/${path}`); await page.waitForLoadState("networkidle").catch(() => {});
        small.push(...await page.evaluate(at => [...document.querySelectorAll<HTMLElement>("body *")].filter(el => {
          const box = el.getBoundingClientRect(), style = getComputedStyle(el);
          return box.width > 1 && box.height > 1 && style.visibility !== "hidden" && !el.closest(".visually-hidden") && [...el.childNodes].some(node => node.nodeType === 3 && node.textContent!.trim()) && parseFloat(style.fontSize) < 12;
        }).map(el => `${at} ${el.tagName.toLowerCase()}.${el.className} ${getComputedStyle(el).fontSize}`), path));
      }
    }
    expect([...new Set(small)]).toEqual([]);
  });

  test("the keyboard shortcuts hint is not shown where there is no keyboard", async ({ page }) => {
    await login(page, "reviewer", "ar"); await page.goto("/ar/notifications");
    await expect(page.getByText(ar.notice.unreadCount).first()).toBeVisible(); await expect(page.getByText(ar.notice.shortcuts)).toBeHidden();
  });

  test("a tap leaves no hover style behind on a button", async ({ page }) => {
    expect(await page.evaluate(() => matchMedia("(hover: none) and (pointer: coarse)").matches)).toBe(true);
    await page.goto("/ar/login"); const button = page.getByRole("button", { name: ar.signIn, exact: true });
    const rest = await background(button); await button.hover();
    expect(await background(button)).toBe(rest);
  });
});

test("a keyboard user reads the shortcuts hint on the notifications page", async ({ page }) => {
  await login(page, "reviewer", "ar"); await page.goto("/ar/notifications"); await expect(page.getByText(ar.notice.shortcuts)).toBeVisible();
});

test("a mouse still gets the hover style of a button", async ({ page }) => {
  await page.goto("/ar/login"); const button = page.getByRole("button", { name: ar.signIn, exact: true });
  const rest = await button.evaluate(el => getComputedStyle(el).backgroundColor); await button.hover();
  expect(await button.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(rest);
});

test("a reporter starts on «my materials»: the desk inbox is not in their navigation, and its urgent alert is not shown to them", async ({ page }) => {
  await login(page, "reporter", "ar"); await expect(page).toHaveURL(/\/ar\/my-materials$/);
  const nav = page.getByRole("navigation", { name: ar.workspace });
  await expect(nav.locator("[aria-current='page']")).toHaveAccessibleName(ar.mine.nav); await expect(nav.getByRole("link", { name: ar.inbox, exact: true })).toHaveCount(0);
  // وارد المكتب ما زال مقروءًا له بعنوانه، بلا إنذار المشرف وصوته
  await page.goto("/ar/inbox"); await expect(page.getByTestId("material-row").first()).toBeVisible(); await expect(page.getByTestId("urgent-alert")).toHaveCount(0);
  // الضابط: المشرف يبدأ من الوارد ويرى الإنذار فيه. الصفحة تُترك أولًا كي لا يسابق خروجُها التلقائي عند زوال الجلسة الانتقالَ التالي
  await page.goto("about:blank"); await page.context().clearCookies(); await login(page, "reviewer", "ar");
  await expect(page).toHaveURL(/\/ar\/inbox$/); await expect(page.getByTestId("urgent-alert")).toBeVisible();
});

test("each page has its own browser title, by its fixed name and never by a material's title", async ({ page }) => {
  await login(page, "reviewer", "ar");
  const titles: string[] = [];
  for (const [path, name] of [["inbox", ar.inbox], ["board", ar.board.title], ["notifications", ar.notice.title], ["materials/20000000-0000-4000-8000-000000000005", ar.pageTitles.material]] as const) {
    await page.goto(`/ar/${path}`); await expect(page).toHaveTitle(`${name} · ${ar.product}`); titles.push(await page.title());
  }
  expect(new Set(titles).size).toBe(titles.length);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/\S/); expect(await page.title()).not.toContain((await page.getByRole("heading", { level: 1 }).innerText()).trim());
  // التنقّل داخل التطبيق يبدّل العنوان أيضًا
  await page.getByRole("navigation", { name: ar.workspace }).getByRole("link", { name: ar.board.title, exact: true }).click(); await expect(page).toHaveTitle(`${ar.board.title} · ${ar.product}`);
  await page.goto("/en/inbox"); await expect(page).toHaveTitle(`${en.inbox} · ${en.product}`);
  await page.goto("about:blank"); await page.context().clearCookies(); await page.goto("/en/login"); await expect(page).toHaveTitle(`${en.pageTitles.login} · ${en.product}`);
});

for (const locale of ["ar", "en"] as Locale[]) test(`a missing page says so in the page's language and leads to the role's start page (${locale})`, async ({ page }) => {
  const t = dict[locale].pageNotFound;
  await page.goto(`/${locale}/no-such-page`); const missing = page.getByTestId("page-not-found");
  await expect(missing.getByRole("heading", { level: 1 })).toHaveText(t.title); await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(missing).not.toContainText(dict[locale].notFound);
  // غير الداخل إلى صفحة الدخول، والداخل إلى صفحة دوره
  await expect(missing.getByRole("link", { name: t.action })).toHaveAttribute("href", `/${locale}/login`);
  await login(page, "reporter", locale); await page.goto(`/${locale}/no-such-page`);
  await expect(page.getByTestId("page-not-found").getByRole("link", { name: t.action })).toHaveAttribute("href", `/${locale}/my-materials`);
});

test("touch layouts give the sort controls, chips, «clear all», filter fields, the breadcrumb back link and the reload button 44px or more", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await login(page, "reviewer", "ar");
  const height = async (locator: import("@playwright/test").Locator) => (await locator.boundingBox())!.height;
  expect(await height(page.locator(".sort-tools select"))).toBeGreaterThanOrEqual(44); expect(await height(page.locator(".sort-tools button"))).toBeGreaterThanOrEqual(44);
  await page.getByLabel(ar.inboxSearch.label).fill("050"); const chips = page.getByRole("list", { name: ar.shell.inbox.activeFilters });
  expect(await height(chips.locator(".chip.removable"))).toBeGreaterThanOrEqual(44); expect(await height(chips.getByRole("button", { name: ar.shell.inbox.clearAll }))).toBeGreaterThanOrEqual(44);
  await page.getByText(ar.filters, { exact: true }).click();
  for (const field of await page.locator(".filters input, .filters select").all()) expect(await height(field)).toBeGreaterThanOrEqual(44);
  await page.goto("/ar/materials/20000000-0000-4000-8000-000000000005");
  expect(await height(page.getByRole("link", { name: ar.back }))).toBeGreaterThanOrEqual(44);
  expect(await height(page.getByRole("button", { name: ar.review.reload, exact: true }))).toBeGreaterThanOrEqual(44);
});

test("the inbox page polls the newsroom snapshot once; the shell counter polls only elsewhere", async ({ page }) => {
  // المستطلعان (الوارد والهيكل) يطلقان عند التركيب معًا، فالمكرَّر يُطلب قبل أن يعود أول ردّ؛ والاستطلاع التالي الشرعي بعد الردّ بخمس ثوانٍ.
  // الدخول ينتهي في الوارد نفسه؛ تُغلق تلك الصفحة أولًا كي لا يُعدّ استطلاعها الجاري.
  await login(page, "reviewer", "ar"); await page.goto("about:blank"); let calls = 0, beforeFirstResponse = -1;
  const isSnapshot = (url: string) => url.endsWith("/api/bff/dashboard/newsroom");
  page.on("request", request => { if (isSnapshot(request.url())) calls++; });
  page.on("response", response => { if (isSnapshot(response.url()) && beforeFirstResponse < 0) beforeFirstResponse = calls; });
  const first = page.waitForResponse(response => isSnapshot(response.url()));
  await page.goto("/ar/inbox"); await first; await expect(page.getByTestId("material-row")).toHaveCount(50);
  expect(beforeFirstResponse).toBe(1);
  calls = 0; await page.goto("/ar/notifications"); await expect.poll(() => calls).toBeGreaterThanOrEqual(1);
});
