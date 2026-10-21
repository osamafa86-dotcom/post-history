import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDuration, formatMoney, lowest, totals } from "../src/lib/store-format";
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

describe("store components", () => {
  it("renders a catalog card with public fields and the shoot day only", () => {
    const html = renderToStaticMarkup(<CatalogCard locale="en" item={{ href: "/en/store/x", title: { ar: "عنوان", en: "Title" }, governorate: "Gaza", shotOn: "2026-10-19", durationMs: 65000, width: 3840, height: 2160, displayName: "Palestine Post", from: offers[0].price }} />);
    expect(html).toContain("Title"); expect(html).toContain("3840×2160"); expect(html).toContain("$150.00"); expect(html).toContain("1:05"); expect(html).toContain("Oct 19, 2026");
    expect(renderToStaticMarkup(<CatalogCard locale="ar" item={{ href: "/ar/store/x", title: { ar: "عنوان", en: "Title" }, governorate: "غزة", shotOn: null, durationMs: null, width: null, height: null, displayName: "الشبكة", from: null }} />)).toContain(ar.store.unavailable);
  });
  it("shows the shoot day without a time even when given one, and only the display name", () => {
    expect(shotDay("2026-10-19T14:37:00Z")).toBe("2026-10-19"); expect(shotDay(null)).toBeNull(); expect(shotDay("bad")).toBeNull();
    const html = renderToStaticMarkup(<CatalogCard locale="en" item={{ href: "/en/store/x", title: { ar: "ع", en: "T" }, governorate: "Gaza", shotOn: "2026-10-19T14:37:00Z", durationMs: null, width: null, height: null, displayName: "Palestine Post", from: null }} />);
    expect(html).toContain("Oct 19, 2026"); expect(html).not.toMatch(/14:37|2:37/); expect(html).toContain("Palestine Post");
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
    expect(renderToStaticMarkup(<CartSummary locale="ar" lines={[]} />)).toContain(ar.store.cartEmpty);
  });
  it("shows the viewer mark over a preview without download controls", () => {
    const html = renderToStaticMarkup(<WatermarkedPreview locale="en" src="/api/bff/catalog/x/preview" viewer="buyer@example.test" />);
    expect(html).toContain("nodownload"); expect(html.toLowerCase()).toContain("disablepictureinpicture"); expect(html).toContain("buyer@example.test");
    expect(renderToStaticMarkup(<WatermarkedPreview locale="en" src={null} viewer="v" />)).toContain(en.store.previewUnavailable);
  });
});
