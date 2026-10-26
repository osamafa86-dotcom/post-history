"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { clock } from "@/lib/editor";
import { formatMoney, localized, totals } from "@/lib/store-format";
import { orderReaders, orderWriters, type Order } from "@/lib/order-policy";
import { useUser } from "../session-boundary";
import { ActionStatus } from "../action-status";
import { CartSummary } from "./cart-summary";
import { useCart } from "./cart";
import { RefundsPanel } from "./refunds";

/** السلة: الطلب يُنشأ منها مرة واحدة بعملة واحدة، ومعه المجموع الذي رآه المشتري (العقد يرفض غير ذلك). */
export function CartPage({ locale }: { locale: Locale }) {
  const m = messages[locale], s = m.store, o = m.orders, me = useUser(), cart = useCart(), mutation = useMutation(), router = useRouter();
  if (!hasRole(me, ...orderWriters)) return <section className="center-state"><h1>{s.cart}</h1><p role="alert">{s.buyersOnly}</p></section>;
  const sums = totals(cart.items.map(i => i.price));
  async function place() {
    const body = { items: cart.items.map(i => ({ listing_id: i.listing_id, license_template_id: i.license_template_id })), expected_total: sums[0] };
    let created: Order | undefined;
    const ok = await mutation.run(JSON.stringify(body), async header => { const result = await browserApi().POST("/orders", { params: { header }, body }); created = result.data; return result; });
    if (ok && created) { cart.clear(); router.push(`/${locale}/store/orders/${created.id}`); }
  }
  return <><Link prefetch={false} className="back-link" href={`/${locale}/store`}>{s.back}</Link>
    <div className="page-heading"><div><h1>{s.cart}</h1><p className="muted">{o.cartLead}</p></div><Link prefetch={false} href={`/${locale}/store/orders`}>{o.title}</Link></div>
    <CartSummary locale={locale} lines={cart.items.map(i => ({ id: i.listing_id, title: i.title, license: i.license, price: i.price, href: `/${locale}/store/${i.listing_id}` }))} onRemove={cart.remove} catalogHref={`/${locale}/store`} checkout={<>
      <ActionStatus status={mutation.status} locale={locale} />
      {mutation.status === 409 && <p className="notice error">{o.conflict}</p>}
      <button disabled={mutation.busy || sums.length !== 1} onClick={() => void place()}>{o.place}</button></>} />
  </>;
}

const statusTone = (status: Order["status"]) => status === "paid" ? "good" : status === "pending_payment" ? "" : "bad";

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
  if (!allowed) return <section className="center-state"><h1>{o.title}</h1><p role="alert">{o.denied}</p></section>;
  return <><Link prefetch={false} className="back-link" href={`/${locale}/store`}>{m.store.back}</Link>
    <div className="page-heading"><div><h1>{o.title}</h1><p className="muted">{o.lead}</p></div></div>
    {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !items ? <p className="center-state" role="status">{m.loading}</p> : !items.length ? <p className="empty">{o.empty}</p>
      : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[o.created, o.items, o.total, o.status, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(order => <tr key={order.id} data-testid="order-row"><td>{formatDate(order.created_at, locale)}</td><td>{order.items.map(i => localized(i.title, locale)).join("، ")}</td><td dir="ltr">{formatMoney(order.total, locale)}</td><td><span className={`badge ${statusTone(order.status)}`}>{o.statuses[order.status]}</span></td><td><Link prefetch={false} href={`/${locale}/store/orders/${order.id}`}>{o.open}</Link></td></tr>)}</tbody></table></div></div>}
  </>;
}

/** الطلب: الدفع عند المزوّد التجريبي المستضاف، والعودة منه لا تؤكد الدفع؛ الصفحة تقرأ الطلب حتى `paid` من الإشعار الموقّع. */
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
    let session: { checkout_url: string; provider: string } | undefined;
    const ok = await mutation.run(`checkout:${id}`, async header => { const result = await browserApi().POST("/orders/{order_id}/checkout", { params: { path: { order_id: id }, header } }); session = result.data; return result; });
    // المزوّد يحدده الخادم؛ الصفحة تسمّيه قبل التوجيه ولا تعرض اختيارًا.
    if (ok && session) { setRedirecting(session.provider === "stripe" ? "stripe" : "sandbox"); window.location.assign(session.checkout_url); }
  }
  async function cancel() {
    const ok = await mutation.run(`cancel:${id}`, header => browserApi().POST("/orders/{order_id}/cancel", { params: { path: { order_id: id }, header } }));
    if (ok) setAttempt(n => n + 1);
  }
  const back = <Link prefetch={false} className="back-link" href={`/${locale}/store/orders`}>{o.title}</Link>;
  if (status) return <>{back}<p className="center-state" role="alert">{status === 404 ? o.notFound : m.error}</p></>;
  if (!order) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  const pending = order.status === "pending_payment", expired = pending && Date.parse(order.expires_at) <= Math.max(checkedAt, now);
  const exclusive = order.items.some(i => i.license_type === "exclusive_temporary"), left = Math.max(0, Date.parse(order.expires_at) - now), late = left < 120000;
  if (returned && pending && !expired) return <>{back}<section className="center-state confirming" data-testid="awaiting">
    {waitedOut ? <div className="notice attention" role="status"><p>{o.stillWaiting}</p><Link prefetch={false} href={`/${locale}/store/orders`}>{o.title}</Link></div>
      : <><span className="spinner" aria-hidden="true" /><p role="status">{o.awaiting}</p></>}
    <p className="caption">{o.orderNumber} <bdi className="mono" dir="ltr">{order.id.slice(0, 8).toUpperCase()}</bdi></p></section></>;
  return <>{back}
    {buyer && pending && <div className="notice attention sandbox-banner" role="status"><strong>{o.sandboxTitle}</strong><p>{o.sandbox}</p></div>}
    <div className="page-heading"><div><p className="eyebrow">{o.order} <bdi className="mono" dir="ltr">{order.id.slice(0, 8).toUpperCase()}</bdi></p><h1 dir="ltr">{formatMoney(order.total, locale)}</h1><p><span className={`badge ${statusTone(order.status)}`} data-testid="order-status">{o.statuses[order.status]}</span>{order.cancel_reason && <small className="muted"> {o.reasons[order.cancel_reason]}</small>}</p></div></div>
    {order.status === "paid" && <div className="notice good" role="status"><p>{o.paidHelp}</p><Link prefetch={false} href={`/${locale}/store/licenses`}>{m.licenses.title}</Link></div>}
    {pending && !expired && <p className={`badge ${late ? "bad" : "attention"} hold-timer`} data-testid="hold-timer" aria-live="off">{(exclusive ? o.holdEnds : o.payWithin).split("{time}")[0]}<span className="mono" dir="ltr">{clock(new Date(now - left).toISOString(), now)}</span></p>}
    {pending && late && <p className="visually-hidden" role="status">{expired ? o.holdExpired : o.holdSoon}</p>}
    <div className="checkout-layout">
      {buyer && pending && <section className="card provider-card"><h2>{o.provider} <span className="badge good">{o.secure}</span></h2>
        <p className="caption">{o.providerHelp}</p>{redirecting && <p className="notice" role="status">{o.redirecting[redirecting]}</p>}<ActionStatus status={mutation.status} locale={locale} />{mutation.status === 409 && <p className="notice error">{o.conflict}</p>}{mutation.status === 502 && <p className="notice error">{o.providerBlocked}</p>}
        <div className="actions"><button disabled={mutation.busy || expired} onClick={() => void pay()}>{o.pay} <bdi dir="ltr">{formatMoney(order.total, locale)}</bdi></button><button className="secondary" disabled={mutation.busy} onClick={() => void cancel()}>{o.cancel}</button><Link prefetch={false} className="quiet" href={`/${locale}/store/cart`}>{o.backToCart}</Link></div>{expired && <p className="notice error">{o.expiredHelp}</p>}</section>}
      <section className="card cart-summary"><h2>{o.summary}</h2><ul>{order.items.map(i => <li key={i.id} data-testid="order-item"><span><strong>{localized(i.title, locale)}</strong><small className="muted">{localized(i.license_name, locale)}</small></span><span dir="ltr">{formatMoney(i.price, locale)}</span></li>)}</ul>
        <dl className="metadata">{[[o.created, formatDate(order.created_at, locale)], [pending ? o.payBy : o.paidAt, formatDate(pending ? order.expires_at : order.paid_at, locale)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p className="caption">{m.store.browse.filesAfterPayment}</p></section>
    </div>
    {(order.status === "paid" || order.status === "refunded") && <RefundsPanel locale={locale} order={order} onChange={() => setAttempt(n => n + 1)} />}
  </>;
}
