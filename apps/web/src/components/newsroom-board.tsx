"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Material, NewsroomDashboard } from "@/lib/types";
import { overdueTime } from "@/lib/board";
import { internalNames } from "@/lib/work-name";
import { hasRole } from "@/lib/review";
import { useUser } from "./session-boundary";

// أعمدة لوحة الإنتاج كما في الخطة؛ «جاهز للإنتاج» هي الحالة التحريرية accepted.
export const boardColumns = ["inbox", "reviewing", "accepted", "in_production", "final_review", "published"] as const satisfies readonly Material["editorial_state"][];
type Column = typeof boardColumns[number];
const cardLimit = 20;

export function elapsed(from: string, now: number, locale: Locale) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(from)) / 60000)), h = Math.floor(minutes / 60), d = Math.floor(h / 24);
  const t = messages[locale].board;
  return d ? `${d} ${t.days}` : h ? `${h} ${t.hours}` : `${minutes} ${t.minutes}`;
}

export function NewsroomBoard({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.board, me = useUser();
  const allowed = hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin");
  const [snapshot, setSnapshot] = useState<NewsroomDashboard | null>(null), [cards, setCards] = useState<Partial<Record<Column, Material[]>>>({});
  const [error, setError] = useState(false), [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(); let disposed = false, fast: ReturnType<typeof setTimeout>, slow: ReturnType<typeof setTimeout>;
    // اللقطة كل 5 ثوانٍ (حدّ حداثتها في العقد)، وبطاقات الأعمدة كل 15 ثانية؛ الاستطلاع تسلسلي ويتوقف عند إخفاء التبويب.
    async function pollSnapshot() {
      try { const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal })); if (!disposed) { setSnapshot(data); setNow(Date.now()); setError(false); } }
      catch { if (!disposed && !controller.signal.aborted) setError(true); }
      finally { if (!disposed) fast = setTimeout(pollSnapshot, 5000); }
    }
    async function pollCards() {
      try {
        const pages = await Promise.all(boardColumns.map(state => browserApi().GET("/materials", { params: { query: { editorial_state: state, limit: cardLimit } }, signal: controller.signal }).then(dataOrThrow)));
        if (!disposed) setCards(Object.fromEntries(boardColumns.map((state, i) => [state, pages[i].items])));
      } catch { if (!disposed && !controller.signal.aborted) setError(true); }
      finally { if (!disposed) slow = setTimeout(pollCards, 15000); }
    }
    void pollSnapshot(); void pollCards();
    return () => { disposed = true; controller.abort(); clearTimeout(fast); clearTimeout(slow); };
  }, [allowed]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;
  const count = (state: Column) => snapshot?.editorial.find(item => item.state === state)?.count ?? 0;
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div><Link prefetch={false} className="button secondary" href={`/${locale}/board?display=1`}>{t.openDisplay}</Link></div>
    {error && <p className="notice error" role="alert">{m.stale}</p>}
    {!snapshot ? <p className="center-state" role="status">{m.loading}</p> : <>
      <div className="stats board-stats">
        <article data-testid="urgent-open"><span>{t.urgentOpen}</span><strong>{snapshot.urgent_open}</strong></article>
        <article data-testid="overdue"><span>{t.overdue}</span><strong className={snapshot.overdue_acknowledgements ? "alert-number" : ""}>{snapshot.overdue_acknowledgements}</strong>{overdueTime(snapshot.oldest_overdue_acknowledgement_at, now) && <small>{t.oldestOverdue.replace("{time}", overdueTime(snapshot.oldest_overdue_acknowledgement_at, now)!)}</small>}</article>
        <article><span>{t.reserved}</span><strong>{snapshot.reserved.length}</strong></article>
      </div>
      <p className="muted board-updated">{m.updated}: {formatDate(snapshot.generated_at, locale)}</p>
      <div className="board" role="list">{boardColumns.map(state => <section key={state} className="board-column" role="listitem" aria-labelledby={`column-${state}`} data-testid={`column-${state}`}>
        <h2 id={`column-${state}`}>{m.states.editorial_state[state]} <span className="badge">{count(state)}</span></h2>
        {(cards[state] ?? []).map(material => {
          const reservation = snapshot.reserved.find(r => r.material_id === material.id);
          return <article key={material.id} className={`board-card ${material.priority}`} data-testid="board-card">
            <Link prefetch={false} href={`/${locale}/materials/${material.id}`}>{material.title}</Link>
            <div className="board-meta"><small className={`priority ${material.priority}`}>{m.states.priority[material.priority]}</small><small className="muted">{elapsed(material.created_at, now, locale)}</small>{reservation && <small className="badge">{reservation.reserved_by === me.user_id ? m.review.yourReservation : t.reservedBadge}{internalNames(me) && reservation.reserved_by_name && <> · {t.reservedName.replace("{name}", reservation.reserved_by_name)}</>}</small>}</div>
            {overdueTime(material.acknowledgement_due_at, now) && <p className="attention-text" data-testid="ack-overdue">{t.overdueAge.replace("{time}", overdueTime(material.acknowledgement_due_at, now)!)}</p>}
          </article>;
        })}
        {count(state) > (cards[state]?.length ?? 0) && <Link prefetch={false} className="board-more" href={`/${locale}/inbox`}>{t.more}</Link>}
      </section>)}</div>
      <InboxNow locale={locale} snapshot={snapshot} now={now} />
      <section className="card"><h2>{t.receipts}</h2>{snapshot.recent_receipts.length ? <ul className="receipt-list">{snapshot.recent_receipts.map(r => <li key={r.receipt_number}><Link prefetch={false} href={`/${locale}/materials/${r.material_id}`} dir="ltr">{r.receipt_number}</Link><small className={`priority ${r.priority}`}>{m.states.priority[r.priority]}</small><small className="muted">{formatDate(r.verified_at, locale)}</small></li>)}</ul> : <p className="muted">{t.noReceipts}</p>}</section>
    </>}
  </>;
}

/** «الوارد الآن»: جلسات الرفع الجارية بنسبتها (ADR 0024)؛ معرّفات وأرقام فقط، يشترك فيه الوارد ولوحة غرفة الأخبار. */
export function InboxNow({ locale, snapshot, now }: { locale: Locale; snapshot: NewsroomDashboard; now: number }) {
  const m = messages[locale], t = m.board;
  return <section className="card" data-testid="inbox-now" aria-labelledby="inbox-now-title"><h2 id="inbox-now-title"><span className="live-dot" aria-hidden="true" /> {t.inboxNow}</h2>{snapshot.uploads_in_progress?.length ? <ul className="inbox-now">{snapshot.uploads_in_progress.map(u => {
    const percent = Math.floor((u.bytes_received / u.size_bytes) * 100);
    return <li key={u.upload_session_id} className={u.priority} data-testid="upload-progress"><Link prefetch={false} href={`/${locale}/materials/${u.material_id}`}>{t.kinds[u.kind]}</Link><small className={`priority ${u.priority}`}>{m.states.priority[u.priority]}</small><progress max={u.size_bytes} value={u.bytes_received} aria-label={`${t.kinds[u.kind]} ${percent}%`} /><small className="mono" dir="ltr">{percent}%</small><small className="muted">{elapsed(u.updated_at, now, locale)}</small></li>;
  })}</ul> : <p className="muted">{snapshot.uploads_in_progress ? t.noUploads : t.uploadsUnavailable}</p>}</section>;
}
