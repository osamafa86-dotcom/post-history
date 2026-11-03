import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/measurement.mjs";
import { HOME_PAGES, LANDING, login, PASSWORD_SUBMIT } from "../scripts/web-gap-helpers.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/login-page.json", import.meta.url), "utf8"));
const messages = (locale) => JSON.parse(readFileSync(join(ROOT, "apps/web/messages", `${locale}.json`), "utf8"));
const at = (tree, path) => path.split(".").reduce((node, key) => node?.[key], tree);

/**
 * صفحة بديلة بقواعد Playwright التي تكسر السكربتات: `getByRole`/`getByLabel` بتعبير منتظم يطابق جزءًا من الاسم، والوضع
 * الصارم يرمي حين يطابق المحدِّد أكثر من عنصر عند الفعل (click/fill). `first()` و`count()` لا يرميان.
 */
function fakeLoginPage(locale, home = "inbox") {
  const page = fixture.locales[locale];
  const clicked = [], filled = {};
  // بعد زر الدخول يذهب المتصفح إلى صفحة بداية الدور (الويب: window.location.replace)، وwaitForURL ينتظرها كما في Playwright
  let url = `http://web.test/${locale}/login`;
  const locator = (kind, names, pattern) => {
    const hits = Object.entries(names).filter(([, name]) => pattern.test(name));
    const strict = (action) => {
      if (hits.length !== 1) throw new Error(`strict mode violation: ${kind} ${pattern} resolved to ${hits.length} elements (${action})`);
      return hits[0][0];
    };
    return {
      click: async () => { const hit = strict("click"); clicked.push(hit); if (hit === "signIn") url = `http://web.test/${locale}/${home}`; },
      fill: async (value) => { filled[strict("fill")] = value; },
      count: async () => hits.length,
      first: () => locator(kind, Object.fromEntries(hits.slice(0, 1)), pattern),
    };
  };
  return {
    clicked, filled,
    goto: async () => {},
    getByLabel: (pattern) => locator("label", page.labels, pattern),
    getByRole: (role, { name }) => locator(role, role === "button" ? page.buttons : page.links, name),
    waitForURL: async (pattern) => { if (!pattern.test(url)) throw new Error(`waitForURL: timeout, still on ${url}`); },
  };
}

test("the login fixture names what the web renders today, passkey button included", () => {
  for (const [locale, page] of Object.entries(fixture.locales)) {
    const m = messages(locale);
    for (const group of ["labels", "buttons", "links"]) {
      for (const [key, name] of Object.entries(page[group])) {
        const source = key.includes(".") ? at(m, key) : m[key];
        assert.equal(source, name, `${locale} ${group}.${key}: the fixture drifted from apps/web/messages`);
      }
    }
    assert.ok(page.buttons["signInPage.passkey"], `${locale}: the fixture carries the passkey button`);
  }
});

test("login clicks the password submit button alone, never the passkey button, in both locales", async () => {
  for (const locale of Object.keys(fixture.locales)) {
    const page = fakeLoginPage(locale);
    await login(page, { ACCEPTANCE_BASE_URL: "http://web.test", ACCEPTANCE_TOTP: "123456" }, { email: "a@example.test", password: "x".repeat(12), locale });
    assert.deepEqual(page.clicked, ["signIn"], locale);
    assert.deepEqual(page.filled, { email: "a@example.test", password: "x".repeat(12), totp: "123456" }, locale);
  }
});

test("the old partial selector is what broke: it resolves to both buttons and trips strict mode", async () => {
  for (const locale of Object.keys(fixture.locales)) {
    const names = Object.values(fixture.locales[locale].buttons);
    assert.equal(names.filter((n) => /دخول|Sign in|Login/i.test(n)).length, 2, locale);
    assert.deepEqual(names.filter((n) => PASSWORD_SUBMIT.test(n)), [fixture.locales[locale].buttons.signIn], locale);
    await assert.rejects(() => fakeLoginPage(locale).getByRole("button", { name: /دخول|Sign in|Login/i }).click(), /strict mode violation/);
  }
});

test("login ends on every role's home page (finance on payouts, a role without materials on notifications), not only inbox and store", async () => {
  const source = readFileSync(join(ROOT, "apps/web/src/lib/home-page.ts"), "utf8");
  const declared = /export type HomePage = ([^;]+);/.exec(source)?.[1].match(/"([a-z-]+)"/g).map((q) => q.slice(1, -1));
  assert.deepEqual([...HOME_PAGES].sort(), [...declared].sort(), "HOME_PAGES drifted from apps/web/src/lib/home-page.ts");
  for (const home of HOME_PAGES) {
    for (const locale of Object.keys(fixture.locales)) {
      const page = fakeLoginPage(locale, home);
      await login(page, { ACCEPTANCE_BASE_URL: "http://web.test" }, { email: "f@example.test", password: "x".repeat(12), locale });
      assert.deepEqual(page.clicked, ["signIn"], `${home} ${locale}`);
    }
  }
  assert.equal(LANDING.test("http://web.test/ar/login"), false, "the login page itself is not a landing");
  assert.equal(LANDING.test("http://web.test/en/payouts?x=1"), true);
  assert.equal(LANDING.test("http://web.test/en/payouts-archive"), false);
  // the old wait matched inbox and store only, so a finance or notifications-only account timed out after a good sign-in
  const old = /\/((ar|en)\/)?(inbox|store)(?:\?|$)/;
  for (const home of ["payouts", "notifications"]) assert.ok(!old.test(`http://web.test/en/${home}`) && LANDING.test(`http://web.test/en/${home}`), home);
});
