"use client";
import { messages, type Locale } from "@/lib/i18n";
import { formatMoney, localized, type Localized, type Price } from "@/lib/store-format";

export type LicenseType = "editorial_single" | "editorial_term" | "exclusive_temporary" | "commercial";
export type Offer = { id: string; type: LicenseType; name: Localized; price: Price };
// اختيار الترخيص: الحصري يُعطَّل حين لا يتاح (exclusive_available=false)، والتجاري يحتاج موافقة الإدارة.
export function LicensePicker({ locale, offers, exclusiveAvailable, value, onChange }: { locale: Locale; offers: Offer[]; exclusiveAvailable: boolean; value: string | null; onChange: (id: string) => void }) {
  const s = messages[locale].store;
  if (!offers.length) return <p className="notice">{s.unavailable}</p>;
  return <fieldset className="license-picker"><legend>{s.chooseLicense}</legend>
    {offers.map(offer => {
      const blocked = offer.type === "exclusive_temporary" && !exclusiveAvailable;
      return <label key={offer.id} className={`license-option ${blocked ? "blocked" : ""}`}>
        <input type="radio" name="license" value={offer.id} checked={value === offer.id} disabled={blocked} onChange={() => onChange(offer.id)} />
        <span><strong>{localized(offer.name, locale)}</strong><small className="muted">{s.licenseTypes[offer.type]}</small>{blocked && <small className="field-error">{s.exclusiveTaken}</small>}{offer.type === "commercial" && <small className="muted">{s.needsApproval}</small>}</span>
        <strong dir="ltr">{formatMoney(offer.price, locale)}</strong>
      </label>;
    })}
  </fieldset>;
}
