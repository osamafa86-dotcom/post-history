import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { formatMoney, localized, totals, type LicenseType, type Localized, type Price } from "@/lib/store-format";
import { EmptyState } from "../empty-state";
import { Icon } from "../icon";

export type CartLine = { id: string; title: Localized; license: Localized; licenseType?: LicenseType; price: Price; href?: string };

/**
 * السلة (S3): بند لكل مادة بترخيصه وسعره وزرّ إزالة، والملخّص بجانبها هو الإجمالي (`total`) وحده، بلا مجموع فرعي ولا ضريبة (ADR 0100).
 * عملتان لا تُجمعان: لكلٍّ مجموعها، والطلب بعملة واحدة. الدفع عند المزوّد المستضاف لا هنا.
 */
export function CartSummary({ locale, lines, onRemove, checkout, catalogHref }: { locale: Locale; lines: CartLine[]; onRemove?: (id: string) => void; checkout?: React.ReactNode; catalogHref?: string }) {
  const s = messages[locale].store, c = s.cartPage, b = s.browse, sums = totals(lines.map(line => line.price));
  if (!lines.length) return <EmptyState icon="cart" title={c.emptyTitle} actions={catalogHref && <Link prefetch={false} className="button store" href={catalogHref}>{c.browse}</Link>}><p>{c.emptyBody}</p></EmptyState>;
  return <div className="cart-v2">
    <ul className="cart-v2-lines" aria-label={s.cart}>{lines.map(line => {
      const title = localized(line.title, locale);
      return <li key={line.id} className="cart-v2-line" data-testid="cart-line">
        <span className="cart-v2-thumb" aria-hidden="true"><Icon name="play" size={16} /></span>
        <span className="cart-v2-text"><strong>{title}</strong><small>{[...new Set([localized(line.license, locale), line.licenseType ? s.licenseTypes[line.licenseType] : null])].filter(Boolean).join(s.catalog.listSeparator)}</small>
          {line.href && <Link prefetch={false} className="cart-v2-change" href={line.href}>{b.changeLicense}</Link>}</span>
        <strong className="cart-v2-price" dir="ltr">{formatMoney(line.price, locale)}</strong>
        {onRemove && <button type="button" className="icon-button cart-v2-remove" aria-label={c.removeFor.replace("{title}", title)} onClick={() => onRemove(line.id)}><Icon name="x" /></button>}
      </li>;
    })}</ul>
    <aside className="cart-v2-summary" aria-labelledby="cart-summary-title">
      <h2 id="cart-summary-title">{c.summary}</h2>
      <dl>{sums.map(total => <div key={total.currency}><dt>{c.total}{sums.length > 1 ? ` (${total.currency})` : ""}</dt><dd dir="ltr" data-testid="cart-total">{formatMoney(total, locale)}</dd></div>)}</dl>
      {sums.length > 1 && <p className="notice error" role="alert">{s.currencies}</p>}
      {checkout}
      <p className="caption">{b.filesAfterPayment}</p>
    </aside>
  </div>;
}
