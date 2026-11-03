"use client";
import type { components } from "@/generated/schema";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { formatMoney, localized, type LicenseType, type Localized, type Price } from "@/lib/store-format";

export type Offer = { id: string; type: LicenseType; name: Localized; price: Price; terms?: components["schemas"]["LicenseTerms"] };

/** سطر الشروط تحت اسم الترخيص (S2): نوعه ومدته، من شروط إصدار القالب قبل الشراء (ADR 0035) إن وصلت. */
function summary(offer: Offer, locale: Locale) {
  const s = messages[locale].store, days = offer.terms?.term_days;
  return [s.licenseTypes[offer.type], offer.terms ? (days ? s.item.termDays.replace("{n}", String(days)) : s.item.noTerm) : null].filter(Boolean).join(s.catalog.listSeparator);
}

// اختيار الترخيص (S2): بطاقات راديو حقيقية بسعر كلٍّ منها؛ الحصري يُعطَّل حين لا يتاح (exclusive_available=false)، والتجاري يحتاج موافقة الإدارة.
export function LicensePicker({ locale, offers, exclusiveAvailable, exclusiveUntil, value, onChange }: { locale: Locale; offers: Offer[]; exclusiveAvailable: boolean; exclusiveUntil?: string | null; value: string | null; onChange: (id: string) => void }) {
  const s = messages[locale].store;
  if (!offers.length) return <p className="notice">{s.unavailable}</p>;
  return <fieldset className="license-picker"><legend>{s.chooseLicense}</legend>
    {offers.map(offer => {
      const blocked = offer.type === "exclusive_temporary" && !exclusiveAvailable;
      return <div key={offer.id} className="license-choice"><label className={`license-option${blocked ? " blocked" : ""}`}>
        <input type="radio" name="license" value={offer.id} checked={value === offer.id} disabled={blocked} onChange={() => onChange(offer.id)} />
        <span className="license-option-text"><strong>{localized(offer.name, locale)}</strong><small>{summary(offer, locale)}</small>
          {blocked ? <small className="field-error">{exclusiveUntil ? s.exclusiveUntil.replace("{date}", formatDate(exclusiveUntil, locale)) : s.exclusiveTaken}</small> : offer.type === "exclusive_temporary" && <small className="license-option-note">{s.browse.holdNote}</small>}
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
    [t.territory, terms.territory.kind === "worldwide" ? t.worldwide : terms.territory.countries?.join(", ")],
    [s.termDaysLabel, terms.term_days ?? messages[locale].notAvailable],
    [s.exclusivityHoursLabel, terms.exclusivity_hours ?? messages[locale].notAvailable],
    [t.deliverables, terms.deliverables.map(d => t.deliverableNames[d]).join(list)],
    [t.prohibitions, terms.prohibitions.map(p => t.prohibitionNames[p]).join(list) || messages[locale].notAvailable],
    [t.attribution, localized(terms.attribution, locale)],
  ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>;
}
