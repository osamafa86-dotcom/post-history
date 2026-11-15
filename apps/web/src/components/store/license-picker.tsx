"use client";
import type { components } from "@/generated/schema";
import { countryName } from "@/lib/countries";
import { formatDate, messages, plural, type Locale } from "@/lib/i18n";
import { formatMoney, localized, type LicenseType, type Localized, type Price } from "@/lib/store-format";
import { delivered } from "@/lib/license-policy";

export type Offer = { id: string; type: LicenseType; name: Localized; price: Price; terms?: components["schemas"]["LicenseTerms"] };

/** سطر الشروط تحت اسم الترخيص (S2): نوعه ومدته، من شروط إصدار القالب قبل الشراء (ADR 0035) إن وصلت. */
function summary(offer: Offer, locale: Locale) {
  const s = messages[locale].store, days = offer.terms?.term_days;
  return [s.licenseTypes[offer.type], offer.terms ? (days ? plural(days, s.item.termDays, locale) : s.item.noTerm) : null].filter(Boolean).join(s.catalog.listSeparator);
}

// اختيار الترخيص (S2): بطاقات راديو حقيقية بسعر كلٍّ منها. حصرية نشطة على المادة (`exclusiveUntil`) تعطّل العروض كلها حتى نهايتها، فالخادم لا يبيع
// عليها ترخيصًا قبلها، ويُقال لصاحبها إنها له (`ownExclusive`). والحصري وحده يُعطَّل حين لا يتاح لسبب آخر (exclusive_available=false: محجوز في طلب
// جارٍ أو بيعت المادة بغير حصري). والتجاري يحتاج موافقة الإدارة. ما تملكه المؤسسة ساريًا يُسمّى برقم ترخيصه (`owned`).
export function LicensePicker({ locale, offers, exclusiveAvailable, exclusiveUntil, ownExclusive = false, owned, value, onChange }: { locale: Locale; offers: Offer[]; exclusiveAvailable: boolean; exclusiveUntil?: string | null; ownExclusive?: boolean; owned?: Record<string, string>; value: string | null; onChange: (id: string) => void }) {
  const s = messages[locale].store, held = exclusiveUntil ? formatDate(exclusiveUntil, locale) : null;
  if (!offers.length) return <p className="notice">{s.unavailable}</p>;
  return <fieldset className="license-picker"><legend>{s.chooseLicense}</legend>
    {held && <p className="notice attention" data-testid="exclusive-held">{(ownExclusive ? s.heldByYou : s.heldUntil).replace("{date}", held)}</p>}
    {offers.map(offer => {
      const blocked = !!held || (offer.type === "exclusive_temporary" && !exclusiveAvailable), number = owned?.[offer.id];
      return <div key={offer.id} className="license-choice"><label className={`license-option${blocked ? " blocked" : ""}`}>
        <input type="radio" name="license" value={offer.id} checked={value === offer.id} disabled={blocked} onChange={() => onChange(offer.id)} />
        <span className="license-option-text"><strong>{localized(offer.name, locale)}</strong><small>{summary(offer, locale)}</small>
          {blocked ? <small className="field-error">{held ? s.offerHeld.replace("{date}", held) : s.exclusiveTaken}</small> : offer.type === "exclusive_temporary" && <small className="license-option-note">{s.browse.holdNote}</small>}
          {number && <small className="license-option-note" data-testid="owned-license">{s.ownedLicense.split("{number}")[0]}<bdi dir="ltr" className="ref">{number}</bdi>{s.ownedLicense.split("{number}")[1]}</small>}
          {offer.type === "commercial" && <small className="license-option-note">{s.needsApproval}</small>}</span>
        <strong dir="ltr" className="license-price">{formatMoney(offer.price, locale)}</strong>
      </label>{offer.terms && <OfferTerms terms={offer.terms} locale={locale} />}</div>;
    })}
  </fieldset>;
}

function OfferTerms({ terms, locale }: { terms: components["schemas"]["LicenseTerms"]; locale: Locale }) {
  const t = messages[locale].templates, s = messages[locale].store, list = messages[locale].shell.listSeparator;
  return <details className="offer-terms"><summary>{t.terms}</summary><p>{localized(terms.terms, locale)}</p><dl className="metadata">{[
    [t.usage, terms.usage_media.map(u => t.usageNames[u]).join(list)],
    [t.territory, terms.territory.kind === "worldwide" ? t.worldwide : (terms.territory.countries ?? []).map(code => countryName(code, locale)).join(list)],
    [s.termDaysLabel, terms.term_days ?? messages[locale].notAvailable],
    [s.exclusivityHoursLabel, terms.exclusivity_hours ?? messages[locale].notAvailable],
    [t.deliverables, delivered(terms.deliverables).map(d => t.deliverableNames[d]).join(list)],
    [t.prohibitions, terms.prohibitions.map(p => t.prohibitionNames[p]).join(list) || messages[locale].notAvailable],
    [t.attribution, localized(terms.attribution, locale)],
  ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>;
}
