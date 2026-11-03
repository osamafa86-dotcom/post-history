import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatAmount, formatDuration, formatMoney, longDay, lowest, orderLabel, totals } from "../src/lib/store-format";
import { safeLicense, type IssuedLicense } from "../src/lib/issued-licenses";
import { governorateChips } from "../src/components/store/store-catalog";
import { licenseView } from "../src/components/store/licenses";
import { CatalogCard, shotDay } from "../src/components/store/catalog-card";
import { LicensePicker, type Offer } from "../src/components/store/license-picker";
import { CartSummary } from "../src/components/store/cart-summary";
import { WatermarkedPreview } from "../src/components/store/watermarked-preview";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const name = { ar: "تحريري", en: "Editorial" };
const offers: Offer[] = [
  { id: "a", type: "editorial_single", name, price: { amount_minor: 15000, currency: "USD" } },
  { id: "b", type: "exclusive_temporary", name: { ar: "حصري", en: "Exclusive" }, price: { amount_minor: 90000, currency: "USD" } },
  { id: "c", type: "commercial", name: { ar: "تجاري", en: "Commercial" }, price: { amount_minor: 120000, currency: "USD" } },
];
const noop = () => undefined;

describe("store formatting", () => {
  it("formats minor units and never adds two currencies", () => {
    expect(formatMoney({ amount_minor: 15050, currency: "USD" }, "en")).toBe("$150.50");
    expect(formatMoney({ amount_minor: 15050, currency: "ILS" }, "ar")).toContain("150.50");
    expect(totals([{ amount_minor: 100, currency: "USD" }, { amount_minor: 250, currency: "USD" }, { amount_minor: 900, currency: "ILS" }])).toEqual([{ currency: "USD", amount_minor: 350 }, { currency: "ILS", amount_minor: 900 }]);
    expect(lowest(offers.map(o => o.price))).toEqual({ amount_minor: 15000, currency: "USD" }); expect(lowest([])).toBeNull();
    expect(formatDuration(65000)).toBe("1:05"); expect(formatDuration(3725000)).toBe("1:02:05"); expect(formatDuration(null)).toBeNull();
  });
});

describe("store v2 helpers (S1, S4, S7; ADR 0100, 0101)", () => {
  it("formats amounts for a column that carries its currency, and long days without a time", () => {
    expect(formatAmount({ amount_minor: 47000, currency: "USD" }, "en")).toBe("470.00"); expect(formatAmount({ amount_minor: 12050, currency: "USD" }, "ar")).toBe("120.50");
    expect(longDay("2026-10-28", "ar")).toBe("28 تشرين الأول 2026"); expect(longDay("2026-10-28T23:59:00Z", "en")).toBe("October 28, 2026"); expect(longDay("bad", "en")).toBeNull();
  });
  it("names an order by its readable number, or the first eight of its id for a response without one", () => {
    expect(orderLabel({ id: "3f9c2a1e-0000-4000-8000-000000000001", order_number: "ORD-2026-7K3M9Q2X" })).toBe("ORD-2026-7K3M9Q2X");
    expect(orderLabel({ id: "3f9c2a1e-0000-4000-8000-000000000001" })).toBe("3F9C2A1E");
  });
  it("draws governorate chips from the footage itself, most first, at most eight, keeping the active one", () => {
    const listed = [["رفح", 1], ["غزة", 5], ["دير البلح", 3], ...Array.from({ length: 8 }, (_, i) => [`مدينة ${i}`, 1] as [string, number])] as [string, number][];
    const seen = new Map(listed.flatMap(([name, n]) => Array.from({ length: n }, (_, i) => [`${name}-${i}`, name] as [string, string])));
    const chips = governorateChips(seen);
    expect(chips.slice(0, 3)).toEqual(["غزة", "دير البلح", "رفح"]); expect(chips).toHaveLength(8);
    expect(governorateChips(new Map(), "خانيونس")).toEqual(["خانيونس"]);
  });
  it("shows an ended licence by its date even before the server marks it, and never offers a download for a revoked one", () => {
    const base = { status: "active", valid_until: null, delivery_ready: true } as unknown as IssuedLicense, now = Date.parse("2026-11-03T10:00:00Z");
    expect(licenseView(base, now)).toBe("ready"); expect(licenseView({ ...base, delivery_ready: false }, now)).toBe("preparing");
    expect(licenseView({ ...base, valid_until: "2026-10-12T10:00:00Z" }, now)).toBe("ended"); expect(licenseView({ ...base, status: "expired" }, now)).toBe("ended");
    expect(licenseView({ ...base, status: "revoked", valid_until: "2026-10-12T10:00:00Z" }, now)).toBe("revoked");
  });
  it("passes a licence's order number by its format only", () => {
    const terms = { type: "editorial_single", name: name, terms: name, usage_media: [], territory: { kind: "worldwide" }, term_days: null, exclusivity_hours: null, deliverables: [], attribution: name, prohibitions: [] };
    const licence = { id: "x", license_number: "PH-2026-7K3M9Q2XRT", order_id: "o", order_number: "ORD-2026-7K3M9Q2X", order_item_id: "i", organization_id: "g", listing_id: "l", material_version: 1, title: name, license_template_id: "t", license_version: 1, terms, price: offers[0].price, status: "active", revoked_reason: null, valid_from: "2026-10-26T10:00:00Z", valid_until: null, exclusive_until: null, issued_at: "2026-10-26T10:00:00Z", delivery_ready: true } as unknown as IssuedLicense;
    expect(safeLicense(licence).order_number).toBe("ORD-2026-7K3M9Q2X");
    expect(safeLicense({ ...licence, order_number: "ord-1" })).not.toHaveProperty("order_number");
  });
});

describe("store components", () => {
  it("renders the store card with the watermark badge, the shoot day and governorate, and one action, without a credit", () => {
    const html = renderToStaticMarkup(<CatalogCard locale="en" item={{ href: "/en/store/x", title: { ar: "عنوان", en: "Title" }, governorate: "Gaza", shotOn: "2026-10-19", durationMs: 65000 }} />);
    expect(html).toContain("Title"); expect(html).toContain(en.store.card.previewBadge); expect(html).toContain("Shot October 19, 2026 · Gaza"); expect(html).toContain("1:05");
    expect(html).toContain(en.store.card.cta); expect(html).toContain(`aria-label="${en.store.card.ctaFor.replace("{title}", "Title")}"`);
    const bare = renderToStaticMarkup(<CatalogCard locale="ar" item={{ href: "/ar/store/x", title: { ar: "عنوان", en: "Title" }, governorate: "غزة", shotOn: null, durationMs: null }} />);
    expect(bare).toContain(ar.store.card.previewBadge); expect(bare).toContain("غزة"); expect(bare).not.toContain(ar.store.card.shot.split("{date}")[0]);
  });
  it("shows the shoot day without a time even when given one, and no name at all", () => {
    expect(shotDay("2026-10-19T14:37:00Z")).toBe("2026-10-19"); expect(shotDay(null)).toBeNull(); expect(shotDay("bad")).toBeNull();
    const html = renderToStaticMarkup(<CatalogCard locale="ar" item={{ href: "/ar/store/x", title: { ar: "ع", en: "T" }, governorate: "غزة", shotOn: "2026-10-19T14:37:00Z", durationMs: null, exclusive: true }} />);
    expect(html).toContain("19 تشرين الأول 2026"); expect(html).not.toMatch(/14:37|2:37/); expect(html).toContain(ar.store.browse.exclusive);
    expect(html).not.toContain(ar.store.credit); expect(html).not.toMatch(/sha256|[0-9a-f]{32}/i);
  });
  it("disables exclusivity when it is taken and marks commercial licenses for approval", () => {
    const html = renderToStaticMarkup(<LicensePicker locale="en" offers={offers} exclusiveAvailable={false} value="a" onChange={noop} />);
    expect(html.match(/disabled=""/g)).toHaveLength(1); expect(html).toContain(en.store.exclusiveTaken); expect(html).toContain(en.store.needsApproval);
    expect(renderToStaticMarkup(<LicensePicker locale="en" offers={offers} exclusiveAvailable value={null} onChange={noop} />)).not.toContain("disabled");
  });
  it("totals the cart per currency", () => {
    const lines = [{ id: "1", title: name, license: name, price: offers[0].price }, { id: "2", title: name, license: name, price: { amount_minor: 5000, currency: "ILS" as const } }];
    const html = renderToStaticMarkup(<CartSummary locale="en" lines={lines} />);
    expect(html.match(/data-testid="cart-total"/g)).toHaveLength(2); expect(html).toContain(en.store.currencies);
    const one = renderToStaticMarkup(<CartSummary locale="en" lines={[lines[0]]} onRemove={noop} />);
    expect(one.match(/data-testid="cart-total"/g)).toHaveLength(1); expect(one).toContain(`<dt>${en.store.cartPage.total}</dt>`); expect(one).toContain(`aria-label="${en.store.cartPage.removeFor.replace("{title}", "Editorial")}"`);
    expect(one).not.toMatch(/subtotal|tax/i);
    expect(renderToStaticMarkup(<CartSummary locale="ar" lines={[]} catalogHref="/ar/store" />)).toContain(ar.store.cartPage.emptyTitle);
  });
  it("shows the viewer mark over a preview without download controls", () => {
    const html = renderToStaticMarkup(<WatermarkedPreview locale="en" src="/api/bff/catalog/x/preview" viewer="buyer@example.test" />);
    expect(html).toContain("nodownload"); expect(html.toLowerCase()).toContain("disablepictureinpicture"); expect(html).toContain("buyer@example.test");
    expect(renderToStaticMarkup(<WatermarkedPreview locale="en" src={null} viewer="v" />)).toContain(en.store.previewUnavailable);
  });
});
