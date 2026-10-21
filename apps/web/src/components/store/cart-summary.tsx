import { messages, type Locale } from "@/lib/i18n";
import { formatMoney, localized, totals, type Localized, type Price } from "@/lib/store-format";

export type CartLine = { id: string; title: Localized; license: Localized; price: Price };
// السلة: سطر لكل مادة وترخيص، والمجموع لكل عملة على حدة. الدفع يتم عند المزوّد المستضاف لا هنا.
export function CartSummary({ locale, lines, onRemove, checkout }: { locale: Locale; lines: CartLine[]; onRemove?: (id: string) => void; checkout?: React.ReactNode }) {
  const s = messages[locale].store;
  if (!lines.length) return <p className="empty">{s.cartEmpty}</p>;
  return <section className="card cart-summary" aria-label={s.cart}>
    <ul>{lines.map(line => <li key={line.id} data-testid="cart-line"><span><strong>{localized(line.title, locale)}</strong><small className="muted">{localized(line.license, locale)}</small></span><span dir="ltr">{formatMoney(line.price, locale)}</span>{onRemove && <button className="quiet" onClick={() => onRemove(line.id)}>{s.remove}</button>}</li>)}</ul>
    <dl>{totals(lines.map(line => line.price)).map(total => <div key={total.currency}><dt>{s.total} ({total.currency})</dt><dd dir="ltr" data-testid="cart-total">{formatMoney(total, locale)}</dd></div>)}</dl>
    {totals(lines.map(line => line.price)).length > 1 && <p className="notice">{s.currencies}</p>}
    {checkout}
  </section>;
}
