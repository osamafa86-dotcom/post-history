import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NoAccess } from "../src/components/empty-state";
import { navItems } from "../src/components/workspace-nav";
import { candidateName } from "../src/components/assign-dialog";
import { readCart, storedItem, type CartItem } from "../src/components/store/cart";
import { TrialNotice } from "../src/components/store/trial-notice";
import { ScrollRegion } from "../src/components/scroll-region";
import { homePage } from "../src/lib/home-page";
import { serverMade, staffPreview } from "../src/lib/preview-policy";
import { safeMaterial } from "../src/lib/privacy";
import { accountName } from "../src/lib/work-name";
import { humanDuration, messages, plural, type Locale } from "../src/lib/i18n";
import type { Me, MaterialFile, RoleName } from "../src/lib/types";
import { material, me } from "./fixtures";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const as = (...roles: RoleName[]): Me => ({ ...me, roles: roles.map(name => ({ name, scopes: [] })) as unknown as Me["roles"] });
const locales = ["ar", "en"] as const;
const privacyText = (locale: Locale) => messages[locale].privacy.sections.flatMap(s => [s.heading, ...s.paragraphs]).join("\n");

describe("privacy policy states capture location as ADR 0087/0094/0112 build it", () => {
  it("never says the apps do not request location or never send coordinates", () => {
    expect(privacyText("ar")).not.toMatch(/لا يطلب التطبيقان صلاحية الموقع|لا يرسلان إحداثيات|لا نجمع الموقع/);
    expect(privacyText("en")).not.toMatch(/the apps do not request the location permission|we do not collect location|neither app nor the web interface sends them/i);
  });
  it("says, per platform, that Android asks while in use and optionally, and that iOS capture is deferred", () => {
    const required = {
      ar: ["أثناء استخدام التطبيق وحده", "ولا يطلب الموقع في الخلفية", "والإذن اختياري", "تُرسل المادة حينها بلا إحداثيات", "على مستوى الحقل", "ويُكتب ولا يُقرأ للعرض", "ولا يظهر للمشترين ولا في الكتالوج", "بعد إرساله مع المادة", "وعند تسجيل الخروج", "وبالمسح الطارئ", "وجمع موقع التصوير فيه مؤجَّل", "أما تطبيق iOS فلا يجمع موقع التصوير في هذا الإصدار"],
      en: ["only while the app is in use", "never asks for background location", "The permission is optional", "sent without coordinates", "at field level", "written only, never read back for display", "never shown to buyers or in the catalog", "once it has been sent with the material", "when you sign out", "by the emergency wipe", "collecting the filming location on iOS is deferred", "The iOS app does not collect the filming location in this version"],
    };
    for (const locale of locales) for (const phrase of required[locale]) expect(privacyText(locale), `${locale}: ${phrase}`).toContain(phrase);
  });
  it("keeps the twelve sections in the order the store declarations cite, with the same paragraphs in both languages", () => {
    expect(ar.privacy.sections).toHaveLength(12); expect(en.privacy.sections).toHaveLength(12);
    expect(ar.privacy.sections.map(s => s.paragraphs.length)).toEqual(en.privacy.sections.map(s => s.paragraphs.length));
    expect(ar.privacy.sections[1].heading).toBe("البيانات التي نجمعها"); expect(en.privacy.sections[2].heading).toBe("The original file and precise location");
  });
});

describe("each role lands on a page it can read (finance on payouts, E5)", () => {
  it("lands buyers in the store, material readers in the inbox, finance in payouts, the rest in notifications", () => {
    expect(homePage(as("buyer_member"))).toBe("store"); expect(homePage(as("reporter"))).toBe("inbox"); expect(homePage(as("supervisor"))).toBe("inbox");
    expect(homePage(as("finance"))).toBe("payouts"); expect(homePage(as("finance", "rights_officer"))).toBe("inbox"); expect(homePage(as())).toBe("notifications");
  });
  it("hides the inbox from finance and keeps every other destination finance can read", () => {
    const keys = navItems(as("finance"), "en", "/en/payouts").map(i => i.key);
    expect(keys).not.toContain("inbox"); expect(keys).toContain("payouts"); expect(keys).toContain("notifications");
    expect(navItems(as("finance"), "en", "/en/payouts").filter(i => i.active).map(i => i.key)).toEqual(["payouts"]);
  });
  it("sends finance back to payouts from the no-access state, not to the inbox it cannot read", () => {
    for (const locale of locales) {
      const m = messages[locale], html = renderToStaticMarkup(<NoAccess locale={locale} me={as("finance")} title={m.inbox} denied={m.shell.inbox.denied} />);
      expect(html).toContain(`href="/${locale}/payouts"`); expect(html).toContain(m.shell.noAccess.backPayouts); expect(html).not.toContain(m.shell.noAccess.backInbox);
    }
  });
});

describe("staff preview uses server-made light copies only", () => {
  const file = (patch: Partial<MaterialFile> & { derived_from_id?: string | null }) => ({ id: crypto.randomUUID(), kind: "proxy", state: "verified", mime_type: "video/mp4", created_at: "2026-11-03T09:00:00Z", ...patch }) as MaterialFile;
  const original = "50000000-0000-4000-8000-000000000001";
  it("never picks the phone's uploaded light copy, even when it comes first", () => {
    const phone = file({}), server = file({ derived_from_id: original }), poster = file({ kind: "thumbnail", mime_type: "image/png" });
    expect(serverMade(phone)).toBe(false); expect(serverMade(file({ derived_from_id: "not-an-id" }))).toBe(false); expect(serverMade(server)).toBe(true);
    expect(staffPreview({ files: [phone, server, poster], thumbnail_file_id: null }).proxy).toBe(server);
    const prepared = staffPreview({ files: [phone, poster], thumbnail_file_id: poster.id });
    expect(prepared.proxy).toBeNull(); expect(prepared.poster).toBe(poster);
    expect(staffPreview({ files: [phone], thumbnail_file_id: null })).toEqual({ proxy: null, poster: null, thumbnails: [] });
  });
  it("passes the derivative's source through the BFF only as a file id or null", () => {
    const base = material(1), files = [file({ derived_from_id: original }), file({ derived_from_id: null }), file({ derived_from_id: "x<script>" } as never)];
    const safe = safeMaterial({ ...base, files }, []).files as (MaterialFile & { derived_from_id?: unknown })[];
    expect(safe.map(f => f.derived_from_id)).toEqual([original, null, undefined]); expect(Object.hasOwn(safe[2], "derived_from_id")).toBe(false);
  });
});

describe("people by work name, never by account id", () => {
  it("names an unnamed candidate by the first eight of its id, as the admin list does", () => {
    const id = "10000000-0000-4000-8000-000000000004";
    expect(candidateName({ user_id: id, work_name: null }, "ar")).toBe("حساب 10000000"); expect(candidateName({ user_id: id, work_name: null }, "en")).toBe("Account 10000000");
    expect(candidateName({ user_id: id, work_name: "مونتير" }, "en")).toBe("مونتير");
    expect(accountName("abcdef12-0000-4000-8000-000000000000", "bad\u202ename", "en")).toBe("Account abcdef12");
  });
  it("labels contributors by person, with no account-id field left in the resources", () => {
    for (const locale of locales) { expect(messages[locale].review).not.toHaveProperty("userId"); expect(messages[locale].review.person.length).toBeGreaterThan(0); }
    expect(en.review.shareHelp).not.toMatch(/user ID/i);
  });
});

describe("the cart survives a language switch in this tab only", () => {
  const item: CartItem = { listing_id: "71000000-0000-4000-8000-000000000001", license_template_id: "70000000-0000-4000-8000-000000000001", title: { ar: "لقطات", en: "Footage" }, license: { ar: "تحريري", en: "Editorial" }, license_type: "editorial_single", price: { amount_minor: 15000, currency: "USD" } };
  const store = (value: unknown) => ({ getItem: () => JSON.stringify(value) });
  it("restores the owner's items and drops another account's, damaged or unknown-shaped ones", () => {
    expect(readCart("owner", store({ owner: "owner", items: [item, item, { ...item, listing_id: "x" }, { ...item, extra: 1 }] }))).toEqual([item]);
    expect(readCart("someone-else", store({ owner: "owner", items: [item] }))).toEqual([]);
    expect(readCart("owner", { getItem: () => "{not json" })).toEqual([]); expect(readCart("owner", null)).toEqual([]);
    expect(readCart("owner", { getItem: () => { throw new Error("blocked"); } })).toEqual([]);
    expect(storedItem({ ...item, price: { amount_minor: -1, currency: "USD" } })).toBeNull(); expect(storedItem({ ...item, license_type: "free" })).toBeNull();
  });
});

describe("trial notice and scroll regions", () => {
  it("says the cart's own words wherever it appears", () => {
    for (const locale of locales) {
      const html = renderToStaticMarkup(<TrialNotice locale={locale} />);
      expect(html).toContain(messages[locale].store.cartPage.sandbox); expect(html).toContain('role="note"');
    }
  });
  it("makes a sideways-scrolling table a named region the keyboard reaches", () => {
    const html = renderToStaticMarkup(<ScrollRegion className="table-scroll" label={en.refunds.historyLabel}><table /></ScrollRegion>);
    expect(html).toContain('role="region"'); expect(html).toContain('tabindex="0"'); expect(html).toContain(`aria-label="${en.refunds.historyLabel}"`);
    // اسم المنطقة لا يتضمّن عنوان القسم الذي يحويها
    expect(en.refunds.historyLabel.toLowerCase()).not.toContain(en.refunds.title.toLowerCase()); expect(ar.refunds.historyLabel).not.toContain(ar.refunds.title);
  });
});

describe("wording: plurals, the Arabic dual after a preposition, delivery, and one spelling of license", () => {
  it("gives the store count its Arabic plural forms", () => {
    const forms = ar.store.browse.count;
    expect(plural(1, forms, "ar")).toBe("مادة واحدة في هذه الصفحة"); expect(plural(2, forms, "ar")).toBe("مادتان في هذه الصفحة");
    expect(plural(3, forms, "ar")).toBe("3 مواد في هذه الصفحة"); expect(plural(11, forms, "ar")).toBe("11 مادةً في هذه الصفحة"); expect(plural(100, forms, "ar")).toBe("100 مادة في هذه الصفحة");
    expect(plural(1, en.store.browse.count, "en")).toBe("1 item on this page"); expect(plural(3, en.store.browse.count, "en")).toBe("3 items on this page");
  });
  it("writes the dual in the genitive/accusative that follows «بعد» and «منذ»", () => {
    expect(humanDuration(120000, "ar")).toBe("دقيقتين"); expect(humanDuration(2 * 3600000, "ar")).toBe("ساعتين"); expect(humanDuration(2 * 86400000, "ar")).toBe("يومين"); expect(humanDuration(2000, "ar")).toBe("ثانيتين");
    expect(ar.editor.escalatesIn.replace("{time}", humanDuration(120000, "ar"))).toBe("تُصعَّد بعد دقيقتين.");
    expect(humanDuration(5000, "ar")).toBe("5 ثوانٍ"); expect(humanDuration(11 * 86400000, "ar")).toBe("11 يومًا"); expect(humanDuration(60000, "en")).toBe("1 minute"); expect(humanDuration(120000, "en")).toBe("2 minutes");
  });
  it("names the delivery button the same everywhere in English", () => {
    const produced = Object.values(en.task.produced).join("\n");
    expect(produced).not.toContain("Task delivered"); expect(produced).toContain(`“${en.task.act.done}”`);
    expect(en.task.backToTasks).not.toMatch(/inbox/i);
  });
  it("spells license the contract's way throughout the English interface", () => {
    const values: string[] = []; const walk = (value: unknown) => { if (typeof value === "string") values.push(value); else if (value && typeof value === "object") Object.values(value).forEach(walk); };
    walk(en); expect(values.filter(value => /licen[cs]e/i.test(value) && /licence/i.test(value))).toEqual([]);
  });
});
