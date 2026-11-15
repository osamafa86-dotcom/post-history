import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { currencyConflict, reconcile, blocking } from "../src/lib/cart-policy";
import { heldOn, type IssuedLicense } from "../src/lib/issued-licenses";
import { shownStatus } from "../src/lib/order-policy";
import type { CatalogItem } from "../src/lib/store-format";
import type { CartItem } from "../src/components/store/cart";
import { filtersFromSearch, filtersSearch } from "../src/lib/catalog-filters";
import { CatalogCard } from "../src/components/store/catalog-card";
import { LicensePicker, type Offer } from "../src/components/store/license-picker";
import { CartSummary } from "../src/components/store/cart-summary";
import ar from "../messages/ar.json";
import en from "../messages/en.json";

const text = (ar: string, en: string) => ({ ar, en });
const listingId = "71000000-0000-4000-8000-000000000001", single = "70000000-0000-4000-8000-000000000001", exclusive = "70000000-0000-4000-8000-000000000002";
const usd = (amount_minor: number) => ({ amount_minor, currency: "USD" as const });
const listing = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  listing_id: listingId, material_version: 1, title: text("عنوان اليوم", "Title today"), description: text("و", "d"), shot_list: [], material_types: ["report"], governorate: "غزة", shot_on: "2026-10-19", duration_ms: 1000, width: 1920, height: 1080, credit: "",
  offers: [{ license_template_id: single, license_version: 2, type: "editorial_single", name: text("تحريري", "Editorial"), price: usd(9500) }, { license_template_id: exclusive, license_version: 1, type: "exclusive_temporary", name: text("حصري", "Exclusive"), price: usd(90000) }],
  exclusive_available: true, exclusive_unavailable_until: null, listed_at: "2026-10-21T10:00:00Z", ...over,
});
const inCart = (over: Partial<CartItem> = {}): CartItem => ({ listing_id: listingId, license_template_id: single, title: text("عنوان قديم", "Old title"), license: text("تحريري", "Editorial"), license_type: "editorial_single", price: usd(7525), ...over });
const noop = () => undefined;

describe("the cart against the catalog as it is now", () => {
  it("takes the current price and names the change; an unchanged item carries no note", () => {
    const changed = reconcile(inCart(), listing());
    expect(changed.change).toEqual({ kind: "price", from: usd(7525), to: usd(9500) });
    expect(changed.item).toMatchObject({ price: usd(9500), title: text("عنوان اليوم", "Title today"), license_template_id: single });
    expect(reconcile(inCart({ price: usd(9500) }), listing()).change).toBeNull();
    expect(blocking(changed.change)).toBe(false);
  });
  it("marks what can no longer be bought: a listing that left the catalog, an offer that left the listing, a running exclusivity, an exclusive that is taken", () => {
    expect(reconcile(inCart(), null).change).toEqual({ kind: "gone" });
    expect(reconcile(inCart({ license_template_id: "70000000-0000-4000-8000-000000000009" }), listing()).change).toEqual({ kind: "gone" });
    expect(reconcile(inCart(), listing({ exclusive_available: false, exclusive_unavailable_until: "2026-11-17T00:24:00Z" })).change).toEqual({ kind: "held", until: "2026-11-17T00:24:00Z" });
    expect(reconcile(inCart({ license_template_id: exclusive, price: usd(90000) }), listing({ exclusive_available: false })).change).toEqual({ kind: "held", until: null });
    // غير الحصري يبقى متاحًا حين الحصري وحده محجوز في طلب جارٍ
    expect(reconcile(inCart({ price: usd(9500) }), listing({ exclusive_available: false })).change).toBeNull();
    for (const change of [{ kind: "gone" }, { kind: "held", until: null }] as const) expect(blocking(change)).toBe(true);
    // البند الذي لم يعد متاحًا يبقى كما أُضيف ليراه المشتري ويزيله
    expect(reconcile(inCart(), null).item).toEqual(inCart());
  });
  it("keeps one currency: a second currency is refused by name, replacing the same listing is not", () => {
    const ils = { listing_id: "71000000-0000-4000-8000-000000000002", price: { amount_minor: 9999, currency: "ILS" as const } };
    expect(currencyConflict([inCart()], ils)).toBe("USD");
    expect(currencyConflict([inCart()], { listing_id: listingId, price: ils.price })).toBeNull();
    expect(currencyConflict([], ils)).toBeNull();
    expect(currencyConflict([inCart()], { listing_id: ils.listing_id, price: usd(100) })).toBeNull();
  });
});

describe("catalog filters in the page address", () => {
  it("reads the known filters with accepted values only, and trims the search", () => {
    expect(filtersFromSearch(new URLSearchParams("q=%20%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%20&governorate=%D8%BA%D8%B2%D8%A9&period=week&license_type=commercial&exclusive_available=true&min_height=1080&duration=short&shot_from=2026-10-01&material_type=report")))
      .toEqual({ q: "تقرير", governorate: "غزة", period: "week", license_type: "commercial", exclusive_available: "true", min_height: "1080", duration: "short", shot_from: "2026-10-01", material_type: "report" });
    expect(filtersFromSearch({ q: "   ", period: "year", license_type: "resale", exclusive_available: "yes", min_height: "5", duration: "x", shot_from: "2026-10", material_type: "other", cursor: "abc", city: "x" })).toEqual({});
    expect(filtersFromSearch({ q: ["a", "b"], governorate: undefined })).toEqual({ q: "a" });
    expect(filtersFromSearch({ q: "x".repeat(201) })).toEqual({});
  });
  it("writes them back in a stable order without empty values, so the same filters give the same address", () => {
    expect(filtersSearch({ governorate: "غزة", q: "تقرير", period: "" })).toBe("q=%D8%AA%D9%82%D8%B1%D9%8A%D8%B1&governorate=%D8%BA%D8%B2%D8%A9");
    expect(filtersSearch({})).toBe("");
    expect(filtersSearch({ q: "" })).toBe(filtersSearch({}));
    const round = { q: "خبر عاجل", shot_to: "2026-11-01", exclusive_available: "true" };
    expect(filtersFromSearch(new URLSearchParams(filtersSearch(round)))).toEqual(round);
  });
});

describe("what the organization already holds on a listing", () => {
  const license = (over: Partial<IssuedLicense>) => ({ id: "l", license_number: "PH-2026-7K3M9Q2XRT", listing_id: listingId, license_template_id: single, status: "active", valid_until: null, exclusive_until: null, ...over }) as IssuedLicense;
  const now = Date.parse("2026-11-15T12:00:00Z");
  it("names the active license per template, and leaves out other listings, ended and revoked ones", () => {
    const held = heldOn([
      license({}), license({ license_number: "PH-2026-AAAAAAAAAA", listing_id: "71000000-0000-4000-8000-000000000002" }), license({ license_number: "PH-2026-BBBBBBBBBB", license_template_id: exclusive, status: "revoked" }),
      license({ license_number: "PH-2026-CCCCCCCCCC", license_template_id: exclusive, valid_until: "2026-11-01T00:00:00Z" }),
    ], listingId, now);
    expect(held).toEqual({ numbers: { [single]: "PH-2026-7K3M9Q2XRT" }, exclusiveUntil: null });
  });
  it("knows the organization's own running exclusivity by its end", () => {
    expect(heldOn([license({ license_template_id: exclusive, license_number: "PH-2026-DDDDDDDDDD", exclusive_until: "2026-11-17T00:24:00Z" })], listingId, now)).toEqual({ numbers: { [exclusive]: "PH-2026-DDDDDDDDDD" }, exclusiveUntil: "2026-11-17T00:24:00Z" });
    expect(heldOn([license({ license_template_id: exclusive, exclusive_until: "2026-11-10T00:00:00Z" })], listingId, now).exclusiveUntil).toBeNull();
  });
});

describe("an order whose time ran out", () => {
  it("reads as expired once its time passed, even before the server marks it", () => {
    const at = Date.parse("2026-11-15T12:00:00Z");
    expect(shownStatus({ status: "pending_payment", expires_at: "2026-11-15T11:59:59Z" }, at)).toBe("expired");
    expect(shownStatus({ status: "pending_payment", expires_at: "2026-11-15T12:00:01Z" }, at)).toBe("pending_payment");
    expect(shownStatus({ status: "paid", expires_at: "2026-11-15T11:00:00Z" }, at)).toBe("paid");
  });
});

describe("store components under a running exclusivity, an owned license and a changed cart", () => {
  const offers: Offer[] = [
    { id: `${single}:2`, type: "editorial_single", name: text("تحريري", "Editorial"), price: usd(9500) },
    { id: `${exclusive}:1`, type: "exclusive_temporary", name: text("حصري", "Exclusive"), price: usd(90000) },
  ];
  it("disables every offer while an exclusivity runs, and says until when", () => {
    const html = renderToStaticMarkup(<LicensePicker locale="en" offers={offers} exclusiveAvailable={false} exclusiveUntil="2026-11-17T00:24:00Z" value={null} onChange={noop} />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain(en.store.heldUntil.split("{date}")[0]); expect(html).not.toContain(en.store.heldByYou.split("{date}")[0]);
  });
  it("tells the holder that the exclusivity is its own", () => {
    const html = renderToStaticMarkup(<LicensePicker locale="ar" offers={offers} exclusiveAvailable={false} exclusiveUntil="2026-11-17T00:24:00Z" ownExclusive value={null} onChange={noop} />);
    expect(html).toContain(ar.store.heldByYou.split("{date}")[0]); expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
  it("an exclusive held in a running order blocks the exclusive offer alone", () => {
    const html = renderToStaticMarkup(<LicensePicker locale="en" offers={offers} exclusiveAvailable={false} value={null} onChange={noop} />);
    expect(html.match(/disabled=""/g)).toHaveLength(1); expect(html).toContain(en.store.exclusiveTaken);
  });
  it("marks an offer the organization already holds with its license number, on that offer alone", () => {
    const html = renderToStaticMarkup(<LicensePicker locale="en" offers={offers} exclusiveAvailable owned={{ [`${single}:2`]: "PH-2026-7K3M9Q2XRT" }} value={null} onChange={noop} />);
    expect(html).toContain(en.store.ownedLicense.split("{number}")[0]); expect(html.match(/PH-2026-7K3M9Q2XRT/g)).toHaveLength(1); expect(html.match(/data-testid="owned-license"/g)).toHaveLength(1);
  });
  it("the card says the exclusivity runs until a day instead of offering it", () => {
    const card = { href: "/en/store/x", title: text("ع", "T"), governorate: "غزة", shotOn: "2026-10-19", durationMs: null };
    const held = renderToStaticMarkup(<CatalogCard locale="en" item={{ ...card, exclusive: false, heldUntil: "2026-11-17T00:24:00Z" }} />);
    expect(held).toContain(en.store.card.heldUntil.split("{date}")[0]); expect(held).not.toContain(en.store.browse.exclusive);
    expect(renderToStaticMarkup(<CatalogCard locale="en" item={{ ...card, exclusive: true }} />)).toContain(en.store.browse.exclusive);
  });
  it("the cart names a changed price, flags what is no longer available, and says what to do with two currencies", () => {
    const line = { id: "a", title: text("مادة", "Item"), license: text("تحريري", "Editorial"), price: usd(9500) };
    const html = renderToStaticMarkup(<CartSummary locale="en" lines={[{ ...line, change: { kind: "price", from: usd(7525), to: usd(9500) } }, { ...line, id: "b", change: { kind: "gone" } }, { ...line, id: "c", change: { kind: "held", until: "2026-11-17T00:24:00Z" } }, { ...line, id: "d", change: { kind: "held", until: null } }]} />);
    const changeNote = /<small class="cart-v2-note" data-testid="cart-change">(.*?)<\/small>/.exec(html)![1];
    expect(changeNote.match(/<bdi dir="ltr"/g)).toHaveLength(2); expect(changeNote.replace(/<[^>]+>/g, "")).toBe(en.store.cartPage.priceChanged.replace("{from}", "$75.25").replace("{to}", "$95.00"));
    expect(html).toContain(en.store.cartPage.gone); expect(html).toContain(en.store.cartPage.held.split("{date}")[0]); expect(html).toContain(en.store.cartPage.exclusiveTaken);
    expect(html.match(/data-blocked="true"/g)).toHaveLength(3);
    const mixed = renderToStaticMarkup(<CartSummary locale="ar" lines={[line, { ...line, id: "b", price: { amount_minor: 9999, currency: "ILS" } }]} />);
    expect(mixed).toContain(ar.store.currencies); expect(ar.store.currencies).toMatch(/أزل/); expect(en.store.currencies).toMatch(/[Rr]emove/);
  });
  it("an empty cart points to the order that still awaits payment", () => {
    const html = renderToStaticMarkup(<CartSummary locale="ar" lines={[]} catalogHref="/ar/store" pending={[{ href: "/ar/store/orders/1", label: "ORD-2026-7K3M9Q2X" }]} />);
    expect(html).toContain(ar.store.cartPage.pendingOrder.split("{order}")[0]); expect(html).toContain("ORD-2026-7K3M9Q2X"); expect(html).toContain(ar.store.cartPage.resumePayment); expect(html).toContain('href="/ar/store/orders/1"');
  });
});
