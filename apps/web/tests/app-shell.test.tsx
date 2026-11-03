import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../src/components/top-bar";
import { BottomBar, Sidebar } from "../src/components/app-shell";
import { NoAccess } from "../src/components/empty-state";
import { StateBadge, stateTone } from "../src/components/states";
import { inTab, panelOrder } from "../src/components/notifications-panel";
import { bottomItems, initials, navGroups, navItems, userLine } from "../src/components/workspace-nav";
import { messages, type Locale } from "../src/lib/i18n";
import type { Me, Notification, RoleName } from "../src/lib/types";
import { me } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const as = (...roles: RoleName[]): Me => ({ ...me, roles: roles.map(name => ({ name, scopes: [] })) as unknown as Me["roles"] });
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const rules = (selector: RegExp) => css.split("\n").filter(line => selector.test(line)).join("\n");

describe("v2 newsroom shell (W1, T1, M1; ADR 0085, web-v2.md)", () => {
  it("groups the role's destinations under newsroom, library and admin, with exactly one current page", () => {
    const supervisor = navItems(as("supervisor"), "ar", "/ar/board");
    expect(supervisor.map(i => i.key)).toEqual(["inbox", "board", "upload", "notifications", "form-preview", "archive"]);
    expect(supervisor.filter(i => i.active).map(i => i.key)).toEqual(["board"]);
    expect(navGroups(supervisor).map(([group]) => group)).toEqual(["newsroom", "library"]);
    // الأرشيف الجاهز (W9) في «المكتبة» لطاقم غرفة الأخبار، ولا يراه المراسل ولا المشتري.
    expect(navItems(as("supervisor"), "ar", "/ar/archive").filter(i => i.active).map(i => i.key)).toEqual(["archive"]);
    expect(navItems(as("reporter"), "ar", "/ar/inbox").map(i => i.key)).not.toContain("archive");
    const admin = navItems(as("system_admin"), "ar", "/ar/store/licenses");
    expect(navGroups(admin).map(([group]) => group)).toEqual(["newsroom", "library", "admin"]);
    expect(admin.filter(i => i.active).map(i => i.key)).toEqual(["licenses"]);
    expect(navItems(as("system_admin"), "ar", "/ar/store/orders/1").filter(i => i.active).map(i => i.key)).toEqual(["orders"]);
    expect(navItems(as("system_admin"), "ar", "/ar/store/cart").filter(i => i.active).map(i => i.key)).toEqual(["store"]);
    // تفاصيل المادة تحت الوارد (W2: «الوارد ‹ العنوان»).
    expect(navItems(as("supervisor"), "en", "/en/materials/1").filter(i => i.active).map(i => i.key)).toEqual(["inbox"]);
    expect(navItems(as("reporter"), "en", "/en/my-materials").map(i => i.key)).toContain("my-materials");
    expect(navItems(as("reporter"), "en", "/en/board").map(i => i.key)).not.toContain("board");
  });
  it("shows only what the role may access (E5): an editor sees no admin or money destinations", () => {
    const keys = navItems(as("editor_in_chief"), "ar", "/ar/inbox").map(i => i.key);
    expect(keys).not.toContain("admin"); expect(keys).not.toContain("payouts"); expect(keys).not.toContain("buyer-organizations");
    for (const item of navItems(as("system_admin"), "ar", "/ar/inbox")) { expect(item.icon).toBeTruthy(); expect(item.short.length).toBeGreaterThan(0); }
  });
  it("gives a buyer only the store, licences, orders and organisation", () => {
    const buyer = as("buyer_member");
    expect(navItems(buyer, "ar", "/ar/store").map(i => i.label)).toEqual([ar.store.nav.materials, ar.store.nav.licenses, ar.store.nav.orders, ar.buyers.myOrganization]);
    expect(navItems(buyer, "ar", "/ar/store").filter(i => i.active).map(i => i.key)).toEqual(["store"]);
    expect(navItems(buyer, "ar", "/ar/store/licenses/9").filter(i => i.active).map(i => i.key)).toEqual(["licenses"]);
    expect(navItems(buyer, "ar", "/ar/store/orders").filter(i => i.active).map(i => i.key)).toEqual(["orders"]);
    expect(navItems(buyer, "ar", "/ar/organization").filter(i => i.active).map(i => i.key)).toEqual(["organization"]);
    expect(navItems(buyer, "en", "/en/store").map(i => i.href)).toEqual(["/en/store", "/en/store/licenses", "/en/store/orders", "/en/organization"]);
    // السلة زرّ بعدّاده في الشريط لا وجهة: صفحتها لا تنشّط وجهة، والفاتورة تحت «الطلبات»
    expect(navItems(buyer, "ar", "/ar/store/cart").filter(i => i.active)).toEqual([]);
    expect(navItems(buyer, "ar", "/ar/store/orders/1/invoice").filter(i => i.active).map(i => i.key)).toEqual(["orders"]);
  });
  it("puts four destinations and «more» in the phone bar, notifications always among them (M1)", () => {
    const admin = bottomItems(navItems(as("system_admin"), "ar", "/ar/inbox"));
    expect(admin.primary.map(i => i.key)).toEqual(["inbox", "archive", "board", "notifications"]);
    expect(admin.more.map(i => i.key)).toContain("admin");
    const reporter = bottomItems(navItems(as("reporter"), "ar", "/ar/inbox"));
    expect(reporter.primary.length).toBeLessThanOrEqual(4); expect(reporter.primary.map(i => i.key)).toContain("notifications");
  });
  for (const locale of ["ar", "en"] as Locale[]) it(`renders a labelled sidebar nav with groups, full names and aria-current in ${locale}`, () => {
    const m = messages[locale], items = navItems(as("system_admin"), locale, `/${locale}/inbox`);
    const html = renderToStaticMarkup(<Sidebar items={items} locale={locale} brandHref={`/${locale}/inbox`} badge={3} />);
    expect(html).toContain(`<nav aria-label="${m.workspace}" class="sidebar-nav">`);
    expect([...html.matchAll(/aria-current="page"/g)]).toHaveLength(1);
    for (const group of ["newsroom", "library", "admin"] as const) expect(html).toContain(m.shell.groups[group]);
    // العدّاد زخرفي بجانب الاسم، ووصفه لقارئ الشاشة بـ aria-describedby فلا يتغيّر اسم الرابط.
    expect(html).toMatch(/<span class="nav-badge" aria-hidden="true" dir="ltr">3<\/span>/);
    expect(html).toContain(m.shell.urgentBadge.replace("{n}", "3"));
    expect(html).toContain(`<span class="nav-label">${m.inbox}</span>`);
    expect(html).toContain(m.product);
    const bar = renderToStaticMarkup(<BottomBar items={items} locale={locale} badge={null} account={<span />} />);
    expect(bar).toContain(`aria-label="${m.shell.bottomNav}"`); expect(bar).toContain(m.shell.more);
  });
  it("keeps the wall's own bar for the big screen (W4)", () => {
    const html = renderToStaticMarkup(<TopBar variant="wall" locale="ar" brandHref="/ar/board" items={[{ key: "board", href: "/ar/board?display=1", label: "x", short: "x", active: true, group: "newsroom", icon: "wall" }]} navLabel={ar.workspace}><span>end</span></TopBar>);
    expect(html).toMatch(/^<header class="topbar wall"/); expect(html).toContain('aria-current="page"');
  });
  it("shows the internal work name and role, never the email, and initials from them", () => {
    expect(userLine({ ...as("supervisor"), work_name: "نور" }, "ar")).toBe(`نور · ${ar.topbar.roles.supervisor}`);
    expect(userLine(as("producer"), "en")).toBe(en.topbar.roles.producer);
    expect(userLine(me, "en")).toBe(en.topbar.account);
    expect(userLine({ ...as("supervisor"), work_name: "x" }, "en")).not.toContain("example.test");
    expect(initials({ ...as("supervisor"), work_name: "Sara Mansour" }, "en")).toBe("SM");
    expect(initials({ ...as("supervisor"), work_name: "x" }, "en")).not.toMatch(/@/);
  });
  it("labels every role in both languages", () => {
    const roles: RoleName[] = ["system_admin", "editor_in_chief", "supervisor", "producer", "finance", "reporter", "rights_officer", "buyer_admin", "buyer_member"];
    for (const dict of [ar, en]) expect(Object.keys(dict.topbar.roles).sort()).toEqual([...roles].sort());
  });
  it("draws the shell from logical properties and v2 tokens: the sidebar on the start edge, a rail from 768 and a bottom bar below it", () => {
    const shell = rules(/^\.(app-shell|sidebar|nav-item|topbar\.workspace|bottombar|more-sheet)/);
    expect(shell).not.toMatch(/\b(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/);
    expect(shell).toContain("border-inline-end: var(--v2-border-hairline) solid var(--v2-c-border-line)");
    expect(css).toContain("@media (min-width: 768px) and (max-width: 1199px) {\n  .app-shell { grid-template-columns: 76px minmax(0, 1fr); }");
    expect(css).toMatch(/@media \(max-width: 767px\) \{\n  \.app-shell \{ grid-template-columns: minmax\(0, 1fr\); \}\n  \.sidebar \{ display: none; \}/);
    expect(css).toContain(".app-shell { display: grid; grid-template-columns: 240px minmax(0, 1fr);");
  });
});

describe("state badges, notifications panel and no-access (W1, W10, E5)", () => {
  it("gives each of the three states its own tone and icon from material-state, never colour alone", () => {
    expect(stateTone("technical_state", "verified")).toEqual({ tone: "ok", icon: "check" });
    expect(stateTone("technical_state", "proxy_received").tone).toBe("muted"); expect(stateTone("technical_state", "failed").tone).toBe("danger");
    expect(stateTone("editorial_state", "inbox").tone).toBe("warn"); expect(stateTone("editorial_state", "accepted").tone).toBe("ok"); expect(stateTone("editorial_state", "rejected").tone).toBe("danger");
    expect(stateTone("rights_state", "unknown").tone).toBe("muted"); expect(stateTone("rights_state", "sellable").tone).toBe("brand"); expect(stateTone("rights_state", "blocked").tone).toBe("warn");
    const html = renderToStaticMarkup(<StateBadge track="editorial_state" value="inbox" locale="ar" />);
    expect(html).toContain('data-track="editorial_state"'); expect(html).toContain("<svg"); expect(html).toContain(ar.states.editorial_state.inbox);
  });
  it("orders the bell panel urgent first, then unread, then newest, and filters mine and store by the closed event type list", () => {
    const n = (id: string, priority: Notification["priority"], at: string, extra: Partial<Notification> = {}): Notification => ({ id, type: "", title: "", priority, state: "delivered", escalation_level: 0, created_at: at, read_at: null, acknowledged_at: null, ...extra });
    const items = [n("a", "normal", "2026-11-02T10:00:00Z"), n("b", "urgent", "2026-11-02T09:00:00Z"), n("c", "normal", "2026-11-02T11:00:00Z", { read_at: "2026-11-02T11:01:00Z", state: "read" }), n("d", "normal", "2026-11-02T08:00:00Z", { assignment_state: "assigned" }), n("e", "normal", "2026-11-02T07:00:00Z", { type: "order.status_changed", read_at: "2026-11-02T07:01:00Z", state: "read" })];
    expect(panelOrder(items).map(x => x.id)).toEqual(["b", "a", "d", "c", "e"]);
    expect(items.filter(x => inTab(x, "mine")).map(x => x.id)).toEqual(["d"]);
    expect(items.filter(x => inTab(x, "store")).map(x => x.id)).toEqual(["e"]);
  });
  for (const locale of ["ar", "en"] as Locale[]) it(`says the role and what it owns, keeps the page's refusal as an alert, and offers no access request (${locale})`, () => {
    const m = messages[locale], html = renderToStaticMarkup(<NoAccess locale={locale} me={as("editor_in_chief")} title={m.payouts.title} denied={m.payouts.denied} />);
    expect(html).toContain(`<p role="alert">${m.payouts.denied}</p>`);
    expect(html).toContain(m.shell.noAccess.role.replace("{role}", m.topbar.roles.editor_in_chief));
    expect(html).toContain(`href="/${locale}/inbox"`);
    expect(html).not.toMatch(/Request access|اطلب الوصول/); expect(html.match(/<(button|a) /g)).toHaveLength(1);
  });
});
