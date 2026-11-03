"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { longDate, messages, shortTime, type Locale } from "@/lib/i18n";
import { formatAmount, localized, orderLabel } from "@/lib/store-format";
import type { Order } from "@/lib/order-policy";
import type { Organization } from "@/lib/buyer-policy";
import { EmptyState } from "../empty-state";
import { Icon } from "../icon";
import { ScrollRegion } from "../scroll-region";

type Loaded = { order: Order; organization: Organization | null; licenses: Record<string, string> };

/**
 * الفاتورة (S7): ورقة فاتحة (وضع `light` صريح) داخل المتجر الداكن، فعلها «طباعة» من المتصفح. البيانات من `Order` (البنود وسعر كلٍّ منها
 * و`total` و`paid_at` ورقم الطلب ورقم الفاتورة وأمر الشراء، ADR 0100) و`BuyerOrganization` (`legal_name` و`country` و`billing_email`)
 * و`License` (`license_number`). الإجمالي هو `total` وحده، والعملة في رأس العمود. لا مجموع فرعي ولا ضريبة ولا بيانات مُصدِر (سطر مكانها
 * يقول ذلك)، واللافتة التجريبية ثابتة ما دام المزوّد تجريبيًا. لا اسم مراسل ولا مصدر.
 */
export function InvoicePage({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], v = m.store.invoice, list = m.shell.listSeparator;
  const [loaded, setLoaded] = useState<Loaded | null>(null), [status, setStatus] = useState(0), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(), signal = controller.signal, api = browserApi();
    async function load() {
      try {
        const order = dataOrThrow(await api.GET("/orders/{order_id}", { params: { path: { order_id: id } }, signal }));
        // المؤسسة والتراخيص تكمل الورقة؛ غيابها لا يمنع عرض الفاتورة (سطر «—» مكانها).
        const organization = await api.GET("/buyer-organizations/{org_id}", { params: { path: { org_id: order.organization_id } }, signal }).then(dataOrThrow).catch(() => null);
        const numbers = await Promise.all(order.items.filter(i => i.license_id).map(i => api.GET("/licenses/{license_id}", { params: { path: { license_id: i.license_id! } }, signal }).then(dataOrThrow).then(l => [i.id, l.license_number] as const).catch(() => null)));
        if (!signal.aborted) { setLoaded({ order, organization, licenses: Object.fromEntries(numbers.filter((n): n is readonly [string, string] => !!n)) }); setStatus(0); }
      } catch (e) { if (!signal.aborted) setStatus(e instanceof RequestError ? e.status : 503); }
    }
    void load(); return () => controller.abort();
  }, [id, attempt]);
  const crumbs = (current?: string) => <nav className="breadcrumb no-print" aria-label={m.store.item.breadcrumb}><ol><li><Link prefetch={false} href={`/${locale}/store/licenses`}>{v.breadcrumbHome}</Link></li>{current && <li aria-current="page">{current}</li>}</ol></nav>;
  if (status) return <>{crumbs()}{status === 404 || status === 403 ? <EmptyState icon="orders" role="alert" title={v.notFoundTitle}><p>{v.notFoundBody}</p></EmptyState>
    : <EmptyState icon="offline" role="alert" title={m.error} actions={<button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} />}</>;
  if (!loaded) return <>{crumbs()}<p className="center-state" role="status">{m.loading}</p></>;
  const { order, organization, licenses } = loaded, label = orderLabel(order), currency = order.total.currency;
  if (!order.invoice_number || !order.paid_at) return <>{crumbs(v.breadcrumbCurrent.replace("{id}", label))}
    <EmptyState icon="clock" title={v.notPaidTitle} actions={<Link prefetch={false} className="button secondary" href={`/${locale}/store/orders/${order.id}`}>{m.store.cartPage.openOrder}</Link>}><p>{v.notPaidBody}</p></EmptyState></>;
  // الأرقام والمعرّفات معزولة الاتجاه: رقم الترخيص بالخط الأحادي (ADR 0090)، وغيره بأرقام Rubik.
  const mono = (value: string) => <bdi dir="ltr" className="mono">{value}</bdi>, ref = (value: string) => <bdi dir="ltr" className="ref">{value}</bdi>;
  const fill = (text: string, slot: string, value: React.ReactNode) => { const [before, after] = text.split(slot); return <>{before}{value}{after}</>; };
  return <>
    <div className="invoice-bar no-print">{crumbs(v.breadcrumbCurrent.replace("{id}", label))}<button className="store" onClick={() => window.print()}><Icon name="printer" />{v.print}</button></div>
    <article className="invoice-paper" data-mode="light" data-testid="invoice" aria-labelledby="invoice-title">
      <header className="invoice-head">
        <div className="invoice-issuer"><p className="invoice-brand">{m.brand} · {m.product}</p><p className="caption" data-testid="issuer-pending">{v.issuerPending}</p></div>
        <div className="invoice-id"><h1 id="invoice-title">{v.title}</h1><p>{fill(v.number, "{n}", ref(order.invoice_number))}</p><p className="muted">{fill(v.order, "{id}", ref(label))}</p></div>
      </header>
      <p className="invoice-sandbox" role="note" data-testid="invoice-sandbox"><Icon name="alert" size={16} />{v.sandbox}</p>
      <div className="invoice-parties">
        <section><h2>{v.billedTo}</h2>{organization ? <><p><strong>{organization.legal_name}</strong></p><p>{ref(organization.country)}</p><p><bdi dir="ltr">{organization.billing_email}</bdi></p></> : <p>{m.notAvailable}</p>}</section>
        <section><h2>{v.orderBlock}</h2><p>{fill(v.orderNumber, "{id}", ref(label))}</p>
          {order.purchase_order_number && <p data-testid="invoice-po">{fill(v.purchaseOrder, "{po}", ref(order.purchase_order_number))}</p>}
          <p>{v.paidAt.replace("{date}", longDate(order.paid_at, locale))}</p></section>
        <section><h2>{v.status}</h2><p className={`state-word ${order.status === "refunded" ? "muted" : "ok"}`}><Icon name={order.status === "refunded" ? "money" : "check"} size={14} />{order.status === "refunded" ? v.refunded : v.paid}</p>
          <p className="caption">{fill(v.gatewayConfirmed, "{time}", ref(shortTime(order.paid_at)))}</p></section>
      </div>
      <ScrollRegion className="invoice-table" label={v.linesLabel} testId="invoice-lines"><table>
        <thead><tr><th scope="col">{v.colItem}</th><th scope="col">{v.colLicence}</th><th scope="col">{v.colLicenceNo}</th><th scope="col" className="ref">{v.colPrice.replace("{currency}", currency)}</th></tr></thead>
        <tbody>{order.items.map(item => <tr key={item.id} data-testid="invoice-line">
          <td>{localized(item.title, locale)}</td>
          <td>{[...new Set([localized(item.license_name, locale), m.store.licenseTypes[item.license_type]])].join(list)}</td>
          <td>{licenses[item.id] ? mono(licenses[item.id]) : <span className="muted">{v.licencePending}</span>}</td>
          <td className="ref" dir="ltr">{formatAmount(item.price, locale)}</td>
        </tr>)}</tbody>
        <tfoot><tr><th scope="row" colSpan={3}>{v.total.replace("{currency}", currency)}</th><td className="ref" dir="ltr" data-testid="invoice-total">{formatAmount(order.total, locale)}</td></tr></tfoot>
      </table></ScrollRegion>
      <footer className="invoice-notes"><p>{v.paymentNote}</p><p>{v.filesNote}</p></footer>
    </article>
  </>;
}
