"use client";
import { EmptyState, NoAccess } from "../empty-state";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, longDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { clock } from "@/lib/editor";
import { formatMoney, localized, orderLabel, purchaseOrderMax, totals } from "@/lib/store-format";
import { orderReaders, orderWriters, validPurchaseOrder, type Order } from "@/lib/order-policy";
import { useUser } from "../session-boundary";
import { ActionStatus } from "../action-status";
import { Icon } from "../icon";
import { CartSummary } from "./cart-summary";
import { useCart } from "./cart";
import { RefundsPanel } from "./refunds";

type Session = { checkout_url: string; provider: string };

/**
 * السلة والدفع (S3): الطلب يُنشأ من السلة مرة واحدة بعملة واحدة ومعه المجموع الذي رآه المشتري ورقم أمر الشراء إن كُتب (ADR 0100)، ثم
 * تُطلب جلسة الدفع المستضافة ويُوجَّه المتصفح إليها. العودة لا تؤكد الدفع: صفحة الطلب تقرؤه حتى `paid` من الإشعار الموقّع.
 */
export function CartPage({ locale }: { locale: Locale }) {
  const m = messages[locale], s = m.store, c = s.cartPage, o = m.orders, me = useUser(), cart = useCart(), create = useMutation(), checkout = useMutation();
  const [po, setPo] = useState(""), [touched, setTouched] = useState(false), [placed, setPlaced] = useState<Order | null>(null), [redirecting, setRedirecting] = useState<"sandbox" | "stripe" | null>(null);
  if (!hasRole(me, ...orderWriters)) return <NoAccess locale={locale} me={me} title={c.title} denied={s.buyersOnly} />;
  const sums = totals(cart.items.map(i => i.price)), value = po.trim(), poValid = !value || validPurchaseOrder(value), busy = create.busy || checkout.busy || !!redirecting;
  async function proceed() {
    setTouched(true);
    if (!poValid || sums.length !== 1) return;
    const body = { items: cart.items.map(i => ({ listing_id: i.listing_id, license_template_id: i.license_template_id })), expected_total: sums[0], ...(value ? { purchase_order_number: value } : {}) };
    let created: Order | undefined;
    const ok = await create.run(JSON.stringify(body), async header => { const result = await browserApi().POST("/orders", { params: { header }, body }); created = result.data; return result; });
    if (!ok || !created) return;
    const order: Order = created;
    cart.clear(); setPlaced(order);
    let session: Session | undefined;
    // صفحة المزوّد التجريبي والعودة منها بلغة الواجهة (`CheckoutRequest.locale`)
    const opened = await checkout.run(`checkout:${order.id}`, async header => { const result = await browserApi().POST("/orders/{order_id}/checkout", { params: { path: { order_id: order.id }, header }, body: { locale } }); session = result.data; return result; });
    // المزوّد يحدده الخادم؛ الصفحة تسمّيه قبل التوجيه ولا تعرض اختيارًا.
    if (opened && session) { setRedirecting(session.provider === "stripe" ? "stripe" : "sandbox"); window.location.assign(session.checkout_url); }
  }
  const heading = <div className="page-heading"><h1>{c.title}</h1></div>;
  if (placed) return <>{heading}{redirecting ? <p className="notice" role="status">{o.redirecting[redirecting]}</p>
    : <EmptyState icon="alert" role={checkout.busy ? "status" : "alert"} title={`${o.order} ${orderLabel(placed)}`} actions={<Link prefetch={false} className="button store" href={`/${locale}/store/orders/${placed.id}`}>{c.openOrder}</Link>}>
      <p>{checkout.busy ? m.loading : c.checkoutFailed}</p>{checkout.status === 502 && <p>{o.providerBlocked}</p>}</EmptyState>}</>;
  return <>{heading}
    <CartSummary locale={locale} lines={cart.items.map(i => ({ id: i.listing_id, title: i.title, license: i.license, licenseType: i.license_type, price: i.price, href: `/${locale}/store/${i.listing_id}` }))} onRemove={cart.remove} catalogHref={`/${locale}/store`} checkout={<>
      <div className={`field${touched && !poValid ? " invalid" : ""}`}>
        <label htmlFor="purchase-order">{c.poLabel}</label>
        <input id="purchase-order" value={po} maxLength={purchaseOrderMax} dir="ltr" autoComplete="off" spellCheck={false} aria-invalid={touched && !poValid} aria-describedby="purchase-order-help" onChange={e => setPo(e.target.value)} onBlur={() => setTouched(true)} />
        <small id="purchase-order-help" className={touched && !poValid ? "field-error" : "caption"}>{touched && !poValid ? c.poInvalid : c.poHelp}</small>
      </div>
      <ActionStatus status={create.status === 200 ? 0 : create.status} locale={locale} />
      {create.status === 409 && <p className="notice error">{o.conflict}</p>}
      <button className="store" disabled={busy || sums.length !== 1} onClick={() => void proceed()}>{c.checkout}</button>
      <p className="store-sandbox-line" data-testid="sandbox-line"><Icon name="shield" size={14} />{c.sandbox}</p>
    </>} />
  </>;
}

const statusTone = (status: Order["status"]) => status === "paid" ? "good" : status === "pending_payment" ? "attention" : status === "refunded" ? "" : "bad";
const statusIcon = (status: Order["status"]) => status === "paid" ? "check" : status === "pending_payment" ? "clock" : status === "refunded" ? "money" : "x";
function OrderStatus({ status, locale, testId }: { status: Order["status"]; locale: Locale; testId?: string }) {
  return <span className={`badge state-word ${statusTone(status)}`} data-testid={testId}><Icon name={statusIcon(status)} size={14} />{messages[locale].orders.statuses[status]}</span>;
}

/** الطلبات: رقم الطلب المقروء، والمواد، والإجمالي، والحالة بكلمة وأيقونة، والفاتورة للمدفوع. */
export function OrdersPage({ locale }: { locale: Locale }) {
  const m = messages[locale], o = m.orders, me = useUser();
  const [items, setItems] = useState<Order[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const allowed = hasRole(me, ...orderReaders);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/orders", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={o.title} denied={o.denied} />;
  return <>
    <div className="page-heading"><div><h1>{m.store.nav.orders}</h1><p className="muted">{o.lead}</p></div></div>
    {error ? <EmptyState icon="offline" role="alert" title={m.error} actions={<button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} />
      : !items ? <p className="center-state" role="status">{m.loading}</p>
      : !items.length ? <EmptyState icon="orders" title={o.emptyTitle} actions={<Link prefetch={false} className="button store" href={`/${locale}/store`}>{m.store.cartPage.browse}</Link>}><p>{o.emptyBody}</p></EmptyState>
      : <div className="store-table"><table><thead><tr>{[o.colOrder, o.created, o.items, o.total, o.status, o.invoice].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(order => <tr key={order.id} data-testid="order-row">
          <td data-label={o.colOrder}><Link prefetch={false} className="ref" dir="ltr" href={`/${locale}/store/orders/${order.id}`}>{orderLabel(order)}</Link></td>
          <td data-label={o.created}>{longDate(order.created_at, locale)}</td>
          <td data-label={o.items}>{order.items.map(i => localized(i.title, locale)).join(m.shell.listSeparator)}</td>
          <td data-label={o.total} dir="ltr" className="ref">{formatMoney(order.total, locale)}</td>
          <td data-label={o.status}><OrderStatus status={order.status} locale={locale} /></td>
          <td data-label={o.invoice}>{order.invoice_number ? <Link prefetch={false} href={`/${locale}/store/orders/${order.id}/invoice`}><bdi dir="ltr" className="ref">{order.invoice_number}</bdi></Link> : <span className="muted">—</span>}</td>
        </tr>)}</tbody></table></div>}
  </>;
}

/** الطلب: الدفع عند المزوّد المستضاف، والعودة منه لا تؤكد الدفع؛ الصفحة تقرأ الطلب حتى `paid` من الإشعار الموقّع. */
export function OrderPage({ locale, id, returned }: { locale: Locale; id: string; returned: boolean }) {
  const m = messages[locale], o = m.orders, me = useUser(), mutation = useMutation(), buyer = hasRole(me, ...orderWriters);
  const [redirecting, setRedirecting] = useState<"sandbox" | "stripe" | null>(null), [order, setOrder] = useState<Order | null>(null), [checkedAt, setCheckedAt] = useState(0), [status, setStatus] = useState(0), [attempt, setAttempt] = useState(0), polls = useRef(0);
  const [now, setNow] = useState(() => Date.now()), [waitedOut, setWaitedOut] = useState(false);
  // عدّاد مهلة الدفع (وحجز الحصرية) كل ثانية ما دام الطلب بانتظار الدفع.
  useEffect(() => { if (order?.status !== "pending_payment") return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [order?.status]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = dataOrThrow(await browserApi().GET("/orders/{order_id}", { params: { path: { order_id: id } }, signal: controller.signal }));
        if (controller.signal.aborted) return;
        setOrder(data); setCheckedAt(Date.now()); setStatus(0);
        // بعد العودة من المزوّد: قراءة كل 3 ثوانٍ حتى يتغير الطلب، دقيقتين على الأكثر.
        if (returned && data.status === "pending_payment") { if (polls.current++ < 40) timer = setTimeout(load, 3000); else setWaitedOut(true); }
      } catch (e) { if (!controller.signal.aborted) setStatus(e instanceof RequestError ? e.status : 503); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, returned, attempt]);
  async function pay() {
    let session: Session | undefined;
    const ok = await mutation.run(`checkout:${id}`, async header => { const result = await browserApi().POST("/orders/{order_id}/checkout", { params: { path: { order_id: id }, header }, body: { locale } }); session = result.data; return result; });
    if (ok && session) { setRedirecting(session.provider === "stripe" ? "stripe" : "sandbox"); window.location.assign(session.checkout_url); }
  }
  async function cancel() {
    const ok = await mutation.run(`cancel:${id}`, header => browserApi().POST("/orders/{order_id}/cancel", { params: { path: { order_id: id }, header } }));
    if (ok) setAttempt(n => n + 1);
  }
  const crumbs = (current?: string) => <nav className="breadcrumb" aria-label={m.store.item.breadcrumb}><ol><li><Link prefetch={false} href={`/${locale}/store/orders`}>{m.store.nav.orders}</Link></li>{current && <li aria-current="page">{current}</li>}</ol></nav>;
  if (status) return <>{crumbs()}<EmptyState icon={status === 404 ? "orders" : "offline"} role="alert" title={status === 404 ? o.notFound : m.error} actions={status !== 404 && <button className="secondary" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} /></>;
  if (!order) return <>{crumbs()}<p className="center-state" role="status">{m.loading}</p></>;
  const label = orderLabel(order), pending = order.status === "pending_payment", expired = pending && Date.parse(order.expires_at) <= Math.max(checkedAt, now);
  const exclusive = order.items.some(i => i.license_type === "exclusive_temporary"), left = Math.max(0, Date.parse(order.expires_at) - now), late = left < 120000;
  if (returned && pending && !expired) return <>{crumbs(label)}<section className="center-state confirming" data-testid="awaiting">
    {waitedOut ? <div className="notice attention" role="status"><p>{o.stillWaiting}</p><Link prefetch={false} href={`/${locale}/store/orders`}>{m.store.nav.orders}</Link></div>
      : <><span className="spinner" aria-hidden="true" /><p role="status">{o.awaiting}</p></>}
    <p className="caption">{o.orderNumber} <bdi className="ref" dir="ltr">{label}</bdi></p></section></>;
  return <>{crumbs(label)}
    {buyer && pending && <div className="notice attention sandbox-banner" role="status"><strong>{o.sandboxTitle}</strong><p>{o.sandbox}</p></div>}
    <div className="page-heading"><div><p className="eyebrow">{o.order} <bdi className="ref" dir="ltr">{label}</bdi></p><h1 dir="ltr" className="ref">{formatMoney(order.total, locale)}</h1>
      <p><OrderStatus status={order.status} locale={locale} testId="order-status" />{order.cancel_reason && <small className="muted"> {o.reasons[order.cancel_reason]}</small>}</p></div>
      {order.invoice_number && <Link prefetch={false} className="button secondary" href={`/${locale}/store/orders/${order.id}/invoice`}>{o.invoice}</Link>}</div>
    {order.status === "paid" && <div className="notice good" role="status"><p>{o.paidHelp}</p><Link prefetch={false} href={`/${locale}/store/licenses`}>{m.store.nav.licenses}</Link></div>}
    {pending && !expired && <p className={`badge ${late ? "bad" : "attention"} hold-timer`} data-testid="hold-timer" aria-live="off">{(exclusive ? o.holdEnds : o.payWithin).split("{time}")[0]}<span className="mono" dir="ltr">{clock(new Date(now - left).toISOString(), now)}</span></p>}
    {pending && late && <p className="visually-hidden" role="status">{expired ? o.holdExpired : o.holdSoon}</p>}
    <div className="checkout-layout">
      {buyer && pending && <section className="card provider-card"><h2>{o.provider} <span className="badge good">{o.secure}</span></h2>
        <p className="caption">{o.providerHelp}</p>{redirecting && <p className="notice" role="status">{o.redirecting[redirecting]}</p>}<ActionStatus status={mutation.status === 200 ? 0 : mutation.status} locale={locale} />{mutation.status === 409 && <p className="notice error">{o.conflict}</p>}{mutation.status === 502 && <p className="notice error">{o.providerBlocked}</p>}
        <div className="actions"><button className="store" disabled={mutation.busy || expired} onClick={() => void pay()}>{o.pay} <bdi dir="ltr">{formatMoney(order.total, locale)}</bdi></button><button className="secondary" disabled={mutation.busy} onClick={() => void cancel()}>{o.cancel}</button></div>
        {expired && <p className="notice error">{o.expiredHelp}</p>}</section>}
      <section className="card order-summary"><h2>{o.summary}</h2><ul>{order.items.map(i => <li key={i.id} data-testid="order-item"><span><strong>{localized(i.title, locale)}</strong><small className="muted">{localized(i.license_name, locale)}</small></span><span dir="ltr" className="ref">{formatMoney(i.price, locale)}</span></li>)}</ul>
        <dl className="metadata">{[[o.orderNumber, <bdi key="n" dir="ltr" className="ref">{label}</bdi>], ...(order.purchase_order_number ? [[o.purchaseOrder, <bdi key="po" dir="ltr" className="ref">{order.purchase_order_number}</bdi>]] : []),
          ...(order.invoice_number ? [[o.invoiceNumber, <bdi key="inv" dir="ltr" className="ref">{order.invoice_number}</bdi>]] : []),
          [o.created, formatDate(order.created_at, locale)], [pending ? o.payBy : o.paidAt, formatDate(pending ? order.expires_at : order.paid_at, locale)]].map(([name, value]) => <div key={String(name)}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
        <p className="caption">{order.invoice_number ? m.store.browse.filesAfterPayment : o.noInvoice}</p></section>
    </div>
    {(order.status === "paid" || order.status === "refunded") && <RefundsPanel locale={locale} order={order} onChange={() => setAttempt(n => n + 1)} />}
  </>;
}
