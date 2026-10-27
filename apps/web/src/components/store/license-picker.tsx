"use client";
import type { components } from "@/generated/schema";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { formatMoney, localized, type LicenseType, type Localized, type Price } from "@/lib/store-format";

export type Offer = { id: string; type: LicenseType; name: Localized; price: Price; terms?: components["schemas"]["LicenseTerms"] };
// اختيار الترخيص: الحصري يُعطَّل حين لا يتاح (exclusive_available=false)، والتجاري يحتاج موافقة الإدارة.
export function LicensePicker({ locale, offers, exclusiveAvailable, exclusiveUntil, value, onChange }: { locale: Locale; offers: Offer[]; exclusiveAvailable: boolean; exclusiveUntil?: string | null; value: string | null; onChange: (id: string) => void }) {
  const s = messages[locale].store;
  if (!offers.length) return <p className="notice">{s.unavailable}</p>;
  return <fieldset className="license-picker"><legend>{s.chooseLicense}</legend>
    {offers.map(offer => {
      const blocked = offer.type === "exclusive_temporary" && !exclusiveAvailable;
      return <div key={offer.id}><label className={`license-option ${blocked ? "blocked" : ""}`}>
        <input type="radio" name="license" value={offer.id} checked={value === offer.id} disabled={blocked} onChange={() => onChange(offer.id)} />
        <span><strong>{localized(offer.name, locale)}</strong><small className="muted">{s.licenseTypes[offer.type]}</small>{blocked ? <small className="field-error">{exclusiveUntil ? s.exclusiveUntil.replace("{date}", formatDate(exclusiveUntil, locale)) : s.exclusiveTaken}</small> : offer.type === "exclusive_temporary" && <small className="caption">{s.browse.holdNote}</small>}{offer.type === "commercial" && <small className="muted">{s.needsApproval}</small>}</span>
        <strong dir="ltr" className="license-price">{formatMoney(offer.price, locale)}</strong>
      </label>{offer.terms && <OfferTerms terms={offer.terms} locale={locale} />}</div>;
    })}
  </fieldset>;
}

function OfferTerms({ terms, locale }: { terms: components["schemas"]["LicenseTerms"]; locale: Locale }) {
  const t = messages[locale].templates, s = messages[locale].store;
  return <details className="offer-terms"><summary>{t.terms}</summary><p>{localized(terms.terms, locale)}</p><dl className="metadata">{[
    [t.usage, terms.usage_media.map(u => t.usageNames[u]).join("، ")],
    [t.territory, terms.territory.kind === "worldwide" ? t.worldwide : terms.territory.countries?.join(", ")],
    [s.termDaysLabel, terms.term_days ?? messages[locale].notAvailable],
    [s.exclusivityHoursLabel, terms.exclusivity_hours ?? messages[locale].notAvailable],
    [t.deliverables, terms.deliverables.map(d => t.deliverableNames[d]).join("، ")],
    [t.prohibitions, terms.prohibitions.map(p => t.prohibitionNames[p]).join("، ") || messages[locale].notAvailable],
    [t.attribution, localized(terms.attribution, locale)],
  ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>;
}
