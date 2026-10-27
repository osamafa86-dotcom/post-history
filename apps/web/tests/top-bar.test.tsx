import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../src/components/top-bar";
import { navItems, userLine } from "../src/components/workspace-nav";
import { messages, type Locale } from "../src/lib/i18n";
import type { Me, RoleName } from "../src/lib/types";
import { me } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const as = (...roles: RoleName[]): Me => ({ ...me, roles: roles.map(name => ({ name, scopes: [] })) as unknown as Me["roles"] });
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

describe("dark top bar shell (Figma 193:593, 185:333, 193:865; owner decision 2026-10-27)", () => {
  it("shows the role's destinations in order, with exactly one current page", () => {
    const supervisor = navItems(as("supervisor"), "ar", "/ar/board");
    expect(supervisor.map(i => i.key)).toEqual(["inbox", "board", "upload", "form-preview", "notifications"]);
    expect(supervisor.filter(i => i.active).map(i => i.key)).toEqual(["board"]);
    expect(navItems(as("reporter"), "en", "/en/my-materials").map(i => i.key)).toContain("my-materials");
    expect(navItems(as("reporter"), "en", "/en/board").map(i => i.key)).not.toContain("board");
    const admin = navItems(as("system_admin"), "ar", "/ar/store/licenses");
    expect(admin.filter(i => i.active).map(i => i.key)).toEqual(["licenses"]);
    expect(navItems(as("system_admin"), "ar", "/ar/store/orders/1").filter(i => i.active).map(i => i.key)).toEqual(["orders"]);
    expect(navItems(as("system_admin"), "ar", "/ar/store/cart").filter(i => i.active).map(i => i.key)).toEqual(["store"]);
  });
  it("gives a buyer only the store, licences, orders and organisation", () => {
    const buyer = as("buyer_member");
    expect(navItems(buyer, "ar", "/ar/store").map(i => i.label)).toEqual([ar.store.title, ar.licenses.nav, ar.orders.nav, ar.buyers.myOrganization]);
    expect(navItems(buyer, "ar", "/ar/store").filter(i => i.active).map(i => i.key)).toEqual(["store"]);
    expect(navItems(buyer, "ar", "/ar/store/licenses/9").filter(i => i.active).map(i => i.key)).toEqual(["licenses"]);
    expect(navItems(buyer, "ar", "/ar/store/orders").filter(i => i.active).map(i => i.key)).toEqual(["orders"]);
    expect(navItems(buyer, "ar", "/ar/organization").filter(i => i.active).map(i => i.key)).toEqual(["organization"]);
    expect(navItems(buyer, "en", "/en/store").map(i => i.href)).toEqual(["/en/store", "/en/store/licenses", "/en/store/cart", "/en/organization"]);
  });
  for (const locale of ["ar", "en"] as Locale[]) it(`renders a banner with a labelled nav landmark and aria-current in ${locale}`, () => {
    const m = messages[locale], items = navItems(as("supervisor"), locale, `/${locale}/inbox`);
    const html = renderToStaticMarkup(<TopBar variant="workspace" locale={locale} brandHref={`/${locale}/inbox`} items={items} navLabel={m.workspace}><span>end</span></TopBar>);
    expect(html).toMatch(/^<header class="topbar workspace"/);
    expect(html).toContain(`<nav class="topbar-nav" aria-label="${m.workspace}">`);
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>${m.inbox}<|href="/${locale}/inbox"[^>]*aria-current="page"[^>]*>${m.inbox}<`));
    expect(html.indexOf("topbar-brand")).toBeLessThan(html.indexOf("topbar-nav")); expect(html.indexOf("topbar-nav")).toBeLessThan(html.indexOf("topbar-end"));
    expect(html).toContain(m.product);
  });
  it("shows the internal work name and role, never the email", () => {
    expect(userLine({ ...as("supervisor"), work_name: "نور" }, "ar")).toBe(`نور · ${ar.topbar.roles.supervisor}`);
    expect(userLine(as("producer"), "en")).toBe(en.topbar.roles.producer);
    expect(userLine(me, "en")).toBe(en.topbar.account);
    expect(userLine({ ...as("supervisor"), work_name: "x" }, "en")).not.toContain("example.test");
  });
  it("labels every role in both languages", () => {
    const roles: RoleName[] = ["system_admin", "editor_in_chief", "supervisor", "producer", "finance", "reporter", "rights_officer", "buyer_admin", "buyer_member"];
    for (const dict of [ar, en]) expect(Object.keys(dict.topbar.roles).sort()).toEqual([...roles].sort());
  });
  it("draws the bar from logical properties and project tokens only, with the active underline from the logical edge", () => {
    const rules = css.split("\n").filter(l => /^\.topbar|^:root\[data-theme="dark"\] \.topbar/.test(l)).join("\n");
    expect(rules).toContain(".topbar-nav a[aria-current=\"page\"]::after");
    expect(rules).toMatch(/inset-inline: 0; inset-block-end: 0/);
    expect(rules).not.toMatch(/\b(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/);
    // الشريحة الداكنة من رموز Figma نفسها (ADR 0079) لا من أقرب رمز: خلفية ونص وفاصل، بلا قواعد داكنة تعيد تعريفها.
    expect(rules).toMatch(/--bar-bg: var\(--vl-color-bg-slate\)/); expect(rules).toMatch(/--bar-fg: var\(--vl-color-text-on-slate\)/); expect(rules).toMatch(/--bar-line: var\(--vl-color-border-on-slate\)/);
    expect(rules).not.toMatch(/--bar-bg: var\(--vl-color-bg-(inverse|surface)\)/); expect(rules).not.toMatch(/--bar-fg: var\(--vl-color-text-(inverse|primary)\)/);
    expect(rules.match(/--bar-(bg|fg|line):/g)).toHaveLength(3);
  });
});
