import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { formatMoney, localized, totals, type Localized, type Price } from "@/lib/store-format";

export type CartLine = { id: string; title: Localized; license: Localized; price: Price; href?: string };
// السلة (D3): بند لكل مادة وترخيص كبطاقة، والملخص ثابت بجانبها بالمجموع لكل عملة على حدة. الدفع عند المزوّد المستضاف لا هنا.
export function CartSummary({ locale, lines, onRemove, checkout, catalogHref }: { locale: Locale; lines: CartLine[]; onRemove?: (id: string) => void; checkout?: React.ReactNode; catalogHref?: string }) {
  const s = messages[locale].store, b = s.browse, sums = totals(lines.map(line => line.price));
  if (!lines.length) return <section className="empty"><p>{s.cartEmpty}</p>{catalogHref && <Link prefetch={false} href={catalogHref}>{s.back}</Link>}</section>;
  return <div className="cart-layout">
    <ul className="cart-lines" aria-label={s.cart}>{lines.map(line => <li key={line.id} className="card cart-line" data-testid="cart-line">
      <span className="cart-thumb" aria-hidden="true" />
      <span className="cart-line-body"><strong>{localized(line.title, locale)}</strong><small className="muted">{localized(line.license, locale)}</small>
        <span className="cart-line-actions">{line.href && <Link prefetch={false} className="quiet" href={line.href}>{b.changeLicense}</Link>}{onRemove && <button className="quiet" onClick={() => onRemove(line.id)}>{s.remove}</button>}</span></span>
      <strong className="cart-line-price" dir="ltr">{formatMoney(line.price, locale)}</strong></li>)}</ul>
    <aside className="card cart-summary" aria-label={b.summary}>
      <dl>{sums.map(total => <div key={total.currency}><dt>{s.total} ({total.currency})</dt><dd dir="ltr" data-testid="cart-total">{formatMoney(total, locale)}</dd></div>)}</dl>
      {sums.length > 1 && <p className="notice">{s.currencies}</p>}
      {checkout}
      <p className="caption">{b.filesAfterPayment}</p>
    </aside>
  </div>;
}
