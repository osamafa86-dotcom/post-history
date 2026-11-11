"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { fill } from "@/lib/admin-text";
import { formatMoney } from "@/lib/store-format";
import { basisPercent, currentMonth, plainAmount, readiness, shiftMonth, type ContributorEarnings, type ContributorEarningsPage, type ContributorEarningsTotals, type PayoutReadiness } from "@/lib/finance-reports";
import { EmptyState } from "./empty-state";
import { Avatar, ToneBadge } from "./admin-parts";
import { TableSkeleton } from "./users-admin";
import { Icon } from "./icon";
import { fillNodes, Ltr } from "./money";

type Currency = ContributorEarnings["currency"];
const readyTone: Record<PayoutReadiness, { tone: "ok" | "brand" | "muted"; icon: "check" | "payout" | "clock" }> = { ready: { tone: "ok", icon: "check" }, in_payout: { tone: "brand", icon: "payout" }, below_minimum: { tone: "muted", icon: "clock" } };
const pageCap = 10;

export function monthLabel(month: string, locale: Locale) {
  const [year, value] = month.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-PS-u-nu-latn" : "en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, value - 1, 1)));
}
export const nameOf = (row: { user_id: string; work_name: string | null }, locale: Locale) => row.work_name ?? fill(messages[locale].money.unnamed, { id: row.user_id.slice(0, 8) });

/**
 * مستحقات المساهمين في الشهر (A4، والجوال M5؛ ADR 0099): البطاقات مجاميع الجدول نفسه من `totals`، والمعادلة بنصّها فوق الجدول، والعملة
 * في رأس العمود والخلايا أرقام، والحالة من الرصيد الحالي («جاهز للصرف» أو «قيد الصرف» أو «تحت الحد الأدنى»). «بيانات الصرف ناقصة»
 * و«صرف المحدّد» لا يُرسمان: الصرف طلب من المساهم واعتماد من المالية (ADR 0033)، وطلبات الصرف تحت هذا القسم.
 */
export function MoneyOverview({ locale, month, onMonth, onNames }: { locale: Locale; month: string; onMonth: (month: string) => void; onNames?: (names: Record<string, string>) => void }) {
  const m = messages[locale], t = m.money;
  const [data, setData] = useState<{ month: string; items: ContributorEarnings[]; totals: ContributorEarningsTotals[]; partial: boolean } | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [currency, setCurrency] = useState<Currency | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      // الصفحات كلها حتى سقف معقول، فالجدول والمجاميع لصفوف الشهر كله؛ `totals` من الخادم على كل الصفوف أصلًا.
      const items: ContributorEarnings[] = []; let cursor: string | null = null, totals: ContributorEarningsTotals[] = [], pages = 0;
      do {
        const page: ContributorEarningsPage = dataOrThrow(await browserApi().GET("/contributor-earnings", { params: { query: { month, limit: 100, ...(cursor ? { cursor } : {}) } }, signal: controller.signal }));
        items.push(...page.items); totals = page.totals; cursor = page.next_cursor; pages++;
      } while (cursor && pages < pageCap);
      return { month, items, totals, partial: !!cursor };
    }
    load().then(value => { if (!controller.signal.aborted) { setData(value); setFailed(false); onNames?.(Object.fromEntries(value.items.filter(row => row.work_name).map(row => [row.user_id, row.work_name!]))); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [month, attempt, onNames]);
  const current = data?.month === month ? data : null, currencies = current ? [...new Set([...current.totals.map(row => row.currency), ...current.items.map(row => row.currency)])] : [];
  const active = currency && currencies.includes(currency) ? currency : currencies[0] ?? "USD";
  const rows = current?.items.filter(row => row.currency === active) ?? [], total = current?.totals.find(row => row.currency === active) ?? null;
  const ready = rows.filter(row => readiness(row.balance) === "ready").reduce((sum, row) => sum + row.balance.requestable.amount_minor, 0);
  const pct = basisPercent(total?.share_basis_points ?? null, locale), symbol = currencySymbol(active), refunded = rows.some(row => row.refunded.amount_minor > 0);
  const money = (amount: number) => formatMoney({ amount_minor: amount, currency: active }, locale);
  const label = monthLabel(month, locale), future = month >= currentMonth();
  function exportCsv() {
    if (!total) return;
    const header = [t.columns.contributor, t.columns.sales, fill(t.columns.gross, { cur: active }), fill(t.columns.fees, { cur: active }), fill(t.columns.net, { cur: active }), fill(t.columns.share, { pct: pct ?? "", cur: active }), fill(t.columns.refunded, { cur: active }), t.columns.status];
    const amount = (value: { amount_minor: number }) => (value.amount_minor / 100).toFixed(2);
    const lines = [header, ...rows.map(row => [nameOf(row, locale), String(row.sales), amount(row.gross), amount(row.fees_and_taxes), amount(row.net), amount(row.share), amount(row.refunded), t.readiness[readiness(row.balance)]]), [t.total, String(total.sales), amount(total.gross), amount(total.fees_and_taxes), amount(total.net), amount(total.share), amount(total.refunded), ""]];
    // صيغة CSV تُفتح في جداول البيانات؛ العلامة الأولى تجعلها تقرأ العربية بترميزها، والخلايا المبدوءة بمحرف صيغة تُسبق بفاصلة عليا.
    const cell = (value: string) => `"${(/^[=+\-@]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
    const blob = new Blob(["\uFEFF" + lines.map(line => line.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = fill(t.exportFile, { month, cur: active }); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  return <section className="money-overview" aria-labelledby="money-month-title">
    <div className="money-toolbar">
      <div className="month-switch" role="group" aria-label={t.monthLabel}>
        <button type="button" className="icon-button" aria-label={t.monthPrev} onClick={() => onMonth(shiftMonth(month, -1))}><Icon name="chevron" /></button>
        <h2 id="money-month-title" aria-live="polite">{label}</h2>
        <button type="button" className="icon-button next" aria-label={t.monthNext} disabled={future} onClick={() => onMonth(shiftMonth(month, 1))}><Icon name="chevron" /></button>
      </div>
      {currencies.length > 1 && <nav className="quick-tabs" aria-label={t.currency}>{currencies.map(code => <button key={code} type="button" className={active === code ? "chip active" : "chip"} aria-pressed={active === code} onClick={() => setCurrency(code)}>{code}</button>)}</nav>}
      <button type="button" className="secondary" disabled={!total} onClick={exportCsv}><Icon name="download" /> {t.export}</button>
    </div>
    <p className="notice attention sandbox-line" role="note"><Icon name="alert" size={16} /> <span className="wide-text">{t.sandbox}</span><span className="narrow-text">{t.sandboxShort}</span></p>
    {failed && <p className="notice error" role="alert">{current ? m.stale : m.error} <button type="button" className="link-button" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
    {!current ? (failed ? null : <><div className="kpis" aria-hidden="true">{[0, 1, 2, 3].map(i => <article key={i} className="kpi"><span className="skeleton num" /><span className="skeleton line" /></article>)}</div><TableSkeleton columns={7} label={m.loading} /></>)
      : !total || !rows.length ? <EmptyState icon="money" testId="money-empty" title={fill(t.emptyTitle, { month: label })}><p>{t.emptyBody}</p></EmptyState>
      : <>
        <div className="kpis money-kpis" data-testid="money-kpis">
          <article className="kpi wide-only-kpi"><strong dir="ltr">{money(total.gross.amount_minor)}</strong><span>{t.kpiGross}</span></article>
          <article className="kpi wide-only-kpi"><strong dir="ltr">{money(total.net.amount_minor)}</strong><span>{t.kpiNet}</span></article>
          <article className="kpi"><strong dir="ltr" data-testid="kpi-share">{money(total.share.amount_minor)}</strong><span>{t.kpiShare}</span></article>
          <article className="kpi"><strong dir="ltr" data-testid="kpi-ready">{money(ready)}</strong><span>{t.kpiReady}</span></article>
        </div>
        <p className="formula" data-testid="money-formula">{fill(t.formula, { pct: pct ? fill(t.formulaPct, { pct }) : "" })}{!pct && <> {t.formulaMixed}</>}</p>
        <div className="table-panel money-table">
          <div className="card-head"><h3>{t.tableTitle}</h3>{current.partial && <small className="caption">{t.partial}</small>}</div>
          <table className="admin-table earnings-table">
            <thead><tr><th scope="col">{t.columns.contributor}</th><th scope="col" className="num">{t.columns.sales}</th><th scope="col" className="num">{fill(t.columns.gross, { cur: symbol })}</th><th scope="col" className="num">{fill(t.columns.fees, { cur: symbol })}</th><th scope="col" className="num">{fill(t.columns.net, { cur: symbol })}</th><th scope="col" className="num">{fill(t.columns.share, { pct: pct ?? "", cur: symbol })}</th>{refunded && <th scope="col" className="num">{fill(t.columns.refunded, { cur: symbol })}</th>}<th scope="col">{t.columns.status}</th></tr></thead>
            <tbody>{rows.map(row => {
              const state = readiness(row.balance), tone = readyTone[state];
              return <tr key={row.user_id} data-testid="earnings-row">
                <td className="cell-primary"><span className="person"><Avatar name={row.work_name} fallback="?" /><strong><bdi>{nameOf(row, locale)}</bdi></strong></span><span className="row-money narrow-only" dir="ltr">{formatMoney(row.share, locale)}</span><span className="row-sub narrow-only">{fillNodes(t.lineSale, { gross: <Ltr>{plainAmount(row.gross, locale)}</Ltr>, net: <Ltr>{plainAmount(row.net, locale)}</Ltr> })}</span></td>
                <td className="phone-hide num" data-label={t.columns.sales}><span dir="ltr">{row.sales}</span></td>
                <td className="phone-hide num" data-label={fill(t.columns.gross, { cur: symbol })}><span dir="ltr">{plainAmount(row.gross, locale)}</span></td>
                <td className="phone-hide num" data-label={fill(t.columns.fees, { cur: symbol })}><span dir="ltr">{plainAmount(row.fees_and_taxes, locale)}</span></td>
                <td className="phone-hide num" data-label={fill(t.columns.net, { cur: symbol })}><span dir="ltr">{plainAmount(row.net, locale)}</span></td>
                <td className="phone-hide num strong" data-label={fill(t.columns.share, { pct: pct ?? "", cur: symbol })}><span dir="ltr">{plainAmount(row.share, locale)}</span></td>
                {refunded && <td className="phone-hide num" data-label={fill(t.columns.refunded, { cur: symbol })}><span dir="ltr">{plainAmount(row.refunded, locale)}</span></td>}
                <td data-label={t.columns.status}><ToneBadge tone={tone.tone} icon={tone.icon} testId="readiness">{t.readiness[state]}</ToneBadge></td>
              </tr>;
            })}</tbody>
            <tfoot><tr data-testid="earnings-total"><th scope="row" className="cell-primary"><span className="wide-text">{t.total}</span><span className="narrow-text">{fill(t.totalLine, { sales: plural(total.sales, t.sales as PluralForms, locale) })}</span><span className="row-money narrow-only" dir="ltr">{formatMoney(total.share, locale)}</span></th>
              <td className="num"><span dir="ltr">{total.sales}</span></td><td className="num"><span dir="ltr">{plainAmount(total.gross, locale)}</span></td><td className="num"><span dir="ltr">{plainAmount(total.fees_and_taxes, locale)}</span></td><td className="num"><span dir="ltr">{plainAmount(total.net, locale)}</span></td><td className="num strong"><span dir="ltr">{plainAmount(total.share, locale)}</span></td>{refunded && <td className="num"><span dir="ltr">{plainAmount(total.refunded, locale)}</span></td>}<td /></tr></tfoot>
          </table>
        </div>
        <p className="caption">{t.readyNote}</p>
      </>}
  </section>;
}

/** رمز العملة لرأس العمود («$» و«₪»)؛ المبالغ المنفردة تحمله كاملًا. */
export const currencySymbol = (currency: Currency) => ({ USD: "$", ILS: "₪" } as const)[currency] ?? currency;
