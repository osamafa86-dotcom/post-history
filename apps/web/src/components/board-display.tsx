"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import type { NewsroomDashboard } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { clock } from "@/lib/editor";
import { overdueTime, rose, rotateMs, rotation, wallClock, wallDate } from "@/lib/board";
import { countText, isExact, productionColumns } from "@/lib/board-columns";
import { arrange, fetchCap, loadBoard, type BoardData } from "@/lib/board-load";
import { internalNames } from "@/lib/work-name";
import { beep } from "@/lib/alert-sound";
import { useUser } from "./session-boundary";
import { photographer } from "./states";
import { elapsed } from "./newsroom-board";
import { TopBar } from "./top-bar";
import { TrackLegend, TrackLine } from "./track-line";

const fetchLimit = 24, uploadSlots = 3;
// المنقضي mm:ss في الساعة الأولى، ثم بالساعات والأيام كي يبقى مقروءًا من بعيد.
const age = (from: string, now: number, locale: Locale) => now - Date.parse(from) < 3600000 ? clock(from, now) : elapsed(from, now, locale);

/** لوحة غرفة الأخبار على شاشة كبيرة (التدفق ج): بلا رأس ولا شريط جانبي، داكنة افتراضيًا، لا تفاعل على الجدار. */
export function BoardDisplay({ locale, light }: { locale: Locale; light: boolean }) {
  const m = messages[locale], t = m.board, d = t.display, me = useUser();
  const allowed = hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin");
  const [snapshot, setSnapshot] = useState<NewsroomDashboard | null>(null), [loaded, setLoaded] = useState<BoardData | null>(null);
  const [failedSince, setFailedSince] = useState<number | null>(null), [lastOk, setLastOk] = useState(0), [now, setNow] = useState(() => Date.now());
  const [tick, setTick] = useState(0), [still, setStill] = useState(false), [sound, setSound] = useState(false), [idle, setIdle] = useState(false);
  const previous = useRef<NewsroomDashboard | null>(null), soundOn = useRef(false);

  // وضع العرض: يُخفي إطار مساحة العمل ويضبط الوضع الداكن ما لم يُطلب الفاتح، ويُعاد كل شيء عند المغادرة.
  useEffect(() => {
    const root = document.documentElement, theme = root.getAttribute("data-theme");
    root.classList.add("board-display"); root.setAttribute("data-theme", light ? "light" : "dark");
    return () => { root.classList.remove("board-display"); if (theme === null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme", theme); };
  }, [light]);
  // المؤشر يختفي بعد ثلاث ثوانٍ من السكون؛ والنقرة الأولى تفعّل الصوت (قيد المتصفحات).
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), 3000);
    const wake = () => { setIdle(false); clearTimeout(timer); timer = setTimeout(() => setIdle(true), 3000); };
    const enable = () => { soundOn.current = true; setSound(true); };
    window.addEventListener("pointermove", wake); window.addEventListener("pointerdown", enable); window.addEventListener("keydown", enable);
    return () => { clearTimeout(timer); window.removeEventListener("pointermove", wake); window.removeEventListener("pointerdown", enable); window.removeEventListener("keydown", enable); };
  }, []);
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)"), sync = () => setStill(motion.matches); sync();
    motion.addEventListener("change", sync);
    const clockTimer = setInterval(() => setNow(Date.now()), 1000), rotateTimer = setInterval(() => setTick(n => n + 1), rotateMs);
    return () => { motion.removeEventListener("change", sync); clearInterval(clockTimer); clearInterval(rotateTimer); };
  }, []);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController(); let disposed = false, fast: ReturnType<typeof setTimeout>, slow: ReturnType<typeof setTimeout>;
    const failed = () => { if (!disposed && !controller.signal.aborted) setFailedSince(at => at ?? Date.now()); };
    async function pollSnapshot() {
      try {
        const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal }));
        if (disposed) return;
        if (soundOn.current && rose(previous.current, data)) beep();
        previous.current = data; setSnapshot(data); setLastOk(Date.now()); setFailedSince(null);
      } catch { failed(); }
      finally { if (!disposed) fast = setTimeout(pollSnapshot, 5000); }
    }
    async function pollCards() {
      try {
        const data = await loadBoard(controller.signal, fetchLimit);
        if (!disposed) setLoaded(data);
      } catch { failed(); }
      finally { if (!disposed) slow = setTimeout(pollCards, 15000); }
    }
    void pollSnapshot(); void pollCards();
    return () => { disposed = true; controller.abort(); clearTimeout(fast); clearTimeout(slow); };
  }, [allowed]);

  const exit = <Link prefetch={false} className="skip-link" href={`/${locale}/board`}>{d.exit}</Link>;
  if (!allowed) return <section className="center-state">{exit}<h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;
  if (!snapshot || !loaded) return <p className="center-state" role="status">{m.loading}</p>;
  const { counts, cards, capped } = arrange(snapshot, loaded, fetchLimit);
  const uploads = snapshot.uploads_in_progress ?? [], calm = !snapshot.urgent_open && !snapshot.overdue_acknowledgements;
  const tiles = [
    { key: "urgent-open", tone: snapshot.urgent_open ? "urgent" : "neutral", value: snapshot.urgent_open, title: t.urgentOpen, help: d.urgentHelp },
    { key: "overdue", tone: snapshot.overdue_acknowledgements ? "attention" : "neutral", value: snapshot.overdue_acknowledgements, title: t.overdue, help: overdueTime(snapshot.oldest_overdue_acknowledgement_at, now) ? t.oldestOverdue.replace("{time}", overdueTime(snapshot.oldest_overdue_acknowledgement_at, now)!) : d.overdueHelp },
    { key: "reserved", tone: snapshot.reserved.length ? "progress" : "neutral", value: snapshot.reserved.length, title: t.reserved, help: d.reservedHelp },
  ];
  return <div className={`board-wall ${idle ? "idle" : ""}`} data-testid="board-display">
    {exit}
    <TopBar variant="wall" locale={locale} brandHref={`/${locale}/board`} navLabel={m.workspace} items={[{ key: "board", href: `/${locale}/board?display=1`, label: d.nav, active: true }]}>
      <span className="topbar-clock" dir="ltr" data-testid="wall-clock">{wallClock(now)}</span><span className="topbar-date wall-date">{wallDate(now, locale)}</span>
    </TopBar>
    {failedSince !== null ? <p className="wall-banner bad" role="alert">{d.stale.replace("{time}", clock(new Date(lastOk).toISOString(), now))}</p>
      : calm && <p className="wall-banner good" role="status">{d.allClear}</p>}
    {capped && <p className="wall-banner attention" role="status" data-testid="wall-capped">{t.countCapped.replace("{n}", String(fetchCap))}</p>}
    <div className={failedSince !== null ? "wall-body stale" : "wall-body"}>
      <header className="wall-top">
        <div><p className="wall-meta brand">{d.scope.replace("{scope}", me.office_id ? d.myOffice : d.allOffices)}</p><h1>{d.title}</h1>
          <p className="wall-meta muted">{d.snapshot.replace("{time}", wallClock(Date.parse(snapshot.generated_at)))}</p></div>
        <div className="wall-tiles" aria-live="polite">{tiles.map(tile => <article key={tile.key} className={`wall-tile tone-${tile.tone}`} data-testid={`wall-${tile.key}`}>
          <strong className="mono">{tile.value}</strong><span className="wall-title">{tile.title}</span><small className="wall-meta">{tile.help}</small></article>)}</div>
      </header>
      <section className="wall-now" aria-labelledby="wall-now-title">
        <p className="wall-title" id="wall-now-title">{t.inboxNow} <span className="wall-meta">{d.uploading.replace("{n}", String(uploads.length))}</span> <span className="live-dot" aria-hidden="true" /></p>
        {uploads.length ? <ul>{uploads.slice(0, uploadSlots).map(u => {
          const percent = Math.floor((u.bytes_received / u.size_bytes) * 100);
          return <li key={u.upload_session_id} className={u.priority} data-testid="wall-upload"><p className="wall-card-title">{t.kinds[u.kind]} <span className={`badge ${u.priority === "urgent" ? "urgent" : ""}`}>{m.states.priority[u.priority]}</span></p>
            <p className="wall-meta" dir="ltr">{percent}% · {age(u.updated_at, now, locale)}</p><div className="wall-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t.kinds[u.kind]}><span style={{ inlineSize: `${percent}%` }} /></div></li>;
        })}{uploads.length > uploadSlots && <li className="wall-more">{d.more.replace("{n}", String(uploads.length - uploadSlots))}</li>}</ul> : <p className="wall-meta">{t.noUploads}</p>}
      </section>
      <TrackLegend locale={locale} />
      <div className="wall-columns">{productionColumns.map(column => {
        const items = cards[column], { shown, page, pages } = rotation(items, still ? 0 : tick), extra = { count: Math.max(0, counts[column].count - shown.length), upper: Math.max(0, counts[column].upper - shown.length) };
        return <section key={column} className="wall-column" aria-labelledby={`wall-${column}`} data-testid={`wall-column-${column}`}>
          <h2 id={`wall-${column}`} className="wall-title">{t.columns[column]} <span className="wall-count mono">{countText(counts[column])}{!isExact(counts[column]) && <span className="visually-hidden"> {t.atLeast}</span>}</span></h2>
          {!shown.length ? <p className="wall-meta muted wall-empty">{d.empty}</p> : <ol key={page} className="wall-cards">{shown.map(item => {
            const receipt = item.files.find(f => f.receipt_number)?.receipt_number, urgent = item.priority === "urgent";
            return <li key={item.id} className={`wall-card ${item.priority}`} data-testid="wall-card">
              <div className="wall-slate">{item.priority !== "normal" && <span className={`wall-priority ${item.priority}`}>{m.states.priority[item.priority]}</span>}<span className="mono wall-receipt" dir="ltr">{receipt ?? ""}</span><span className={`mono ${urgent ? "danger-text" : ""}`} dir="ltr">{age(item.created_at, now, locale)}</span></div>
              <div className="wall-card-body">
                <p className="wall-card-title">{item.title}</p>
                <p className="wall-card-meta"><span className="wall-place">{item.governorate}</span><span className="wall-meta muted">{photographer(item, locale)}</span></p>
                <TrackLine material={item} locale={locale} size="wall" />
                {overdueTime(item.acknowledgement_due_at, now) && <p className="wall-meta danger-text" data-testid="ack-overdue">{t.overdueAge.replace("{time}", overdueTime(item.acknowledgement_due_at, now)!)}</p>}
                {item.reserved_by && <p><span className="badge progress">{internalNames(me) && item.reserved_by_name ? t.reservedName.replace("{name}", item.reserved_by_name) : d.reservedPill}</span></p>}
              </div>
            </li>;
          })}</ol>}
          {extra.upper > 0 && <p className="wall-meta wall-more">{d.more.replace("{n}", countText(extra))}{pages > 1 && !still && <> · <span dir="ltr">{page + 1}/{pages}</span></>}</p>}
        </section>;
      })}</div>
      <footer className="wall-foot wall-meta"><p className="muted">{d.privacy}</p><p data-testid="wall-sound"><span aria-hidden="true">{sound ? "🔔" : "🔕"}</span> {sound ? d.soundOn : d.soundOff}</p></footer>
    </div>
  </div>;
}
