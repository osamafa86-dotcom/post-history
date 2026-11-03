"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { humanDuration, messages, type Locale } from "@/lib/i18n";
import type { Material, NewsroomDashboard } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { clock } from "@/lib/editor";
import { overdueTime, rose, rotateMs, rotation, wallMinutes, wallOrder, wallPage } from "@/lib/board";
import { tabCounts } from "@/lib/inbox-tabs";
import { mediaDuration } from "@/lib/assignment-policy";
import { beep } from "@/lib/alert-sound";
import { photographer } from "./states";
import { useUser } from "./session-boundary";

const uploadSlots = 3, fetchLimit = 100;

/** يجمع الوارد كما يراه الجدار: العاجل كله (حتى السقف) ثم الأحدث، بلا تكرار؛ فلا يغيب عاجل قديم خلف مئة مادة أحدث. */
async function loadInbox(signal: AbortSignal): Promise<{ items: Material[]; capped: boolean }> {
  const get = (query: { editorial_state: "inbox"; limit: number; priority?: "urgent" }) => browserApi().GET("/materials", { params: { query }, signal }).then(dataOrThrow);
  const [urgent, recent] = await Promise.all([get({ editorial_state: "inbox", priority: "urgent", limit: fetchLimit }), get({ editorial_state: "inbox", limit: fetchLimit })]);
  const seen = new Set(urgent.items.map(item => item.id));
  return { items: [...urgent.items, ...recent.items.filter(item => !seen.has(item.id))], capped: !!(urgent.next_cursor || recent.next_cursor) };
}

/**
 * الجدار (W4، 1920×1080، داكن): «الجدار» ومؤشّرات الوارد والعاجل الذي لم يُستلم والمتأخر عن الإقرار والساعة، ثم بلاطات الوارد
 * (`Web/Wall tile`) العاجل أولًا ثم الأحدث، ثمانٍ في الصفحة تتبدّل كل عشرين ثانية. لا تفاعل على الجدار، ولا أسماء مصادر
 * ولا مواقع دقيقة: المحافظة واسم الظهور وحدهما. يبقى ما يحتاجه جدار الغرفة: لافتة التقادم والتعتيم، والصوت عند ارتفاع العاجل أو
 * المتأخر، وشريط الرفع الجاري (ADR 0097).
 */
export function BoardDisplay({ locale, light }: { locale: Locale; light: boolean }) {
  const m = messages[locale], t = m.board, d = t.display, w = t.wall, me = useUser();
  const allowed = hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin");
  const [snapshot, setSnapshot] = useState<NewsroomDashboard | null>(null), [inbox, setInbox] = useState<{ items: Material[]; capped: boolean } | null>(null);
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
    // اللقطة كل 5 ثوانٍ (حدّ حداثتها في العقد)، والبلاطات كل 15 ثانية؛ الاستطلاع تسلسلي.
    async function pollSnapshot() {
      try {
        const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal }));
        if (disposed) return;
        if (soundOn.current && rose(previous.current, data)) beep();
        previous.current = data; setSnapshot(data); setLastOk(Date.now()); setFailedSince(null);
      } catch { failed(); }
      finally { if (!disposed) fast = setTimeout(pollSnapshot, 5000); }
    }
    async function pollTiles() {
      try { const data = await loadInbox(controller.signal); if (!disposed) setInbox(data); }
      catch { failed(); }
      finally { if (!disposed) slow = setTimeout(pollTiles, 15000); }
    }
    void pollSnapshot(); void pollTiles();
    return () => { disposed = true; controller.abort(); clearTimeout(fast); clearTimeout(slow); };
  }, [allowed]);

  const exit = <Link prefetch={false} className="skip-link" href={`/${locale}/board`}>{d.exit}</Link>;
  if (!allowed) return <section className="center-state">{exit}<h1>{w.title}</h1><p role="alert">{t.denied}</p></section>;
  if (!snapshot || !inbox) return <p className="center-state" role="status">{m.loading}</p>;
  const counts = tabCounts(snapshot), uploads = snapshot.uploads_in_progress ?? [], tiles = wallOrder(inbox.items);
  const { shown, page, pages } = rotation(tiles, still ? 0 : tick, wallPage), hidden = Math.max(0, counts.inbox - shown.length);
  const kpis = [
    { key: "inbox", tone: "neutral", value: counts.inbox, label: w.inbox },
    { key: "urgent-open", tone: snapshot.urgent_open ? "urgent" : "neutral", value: snapshot.urgent_open, label: w.urgent },
    { key: "overdue", tone: snapshot.overdue_acknowledgements ? "attention" : "neutral", value: snapshot.overdue_acknowledgements, label: w.overdue },
  ];
  return <div className={`board-wall ${idle ? "idle" : ""}`} data-testid="board-display">
    {exit}
    {failedSince !== null && <p className="wall-banner bad" role="alert">{d.stale.replace("{time}", clock(new Date(lastOk).toISOString(), now))}</p>}
    {inbox.capped && <p className="wall-banner attention" role="status" data-testid="wall-capped">{w.capped.replaceAll("{n}", String(fetchLimit))}</p>}
    <div className={failedSince !== null ? "wall-body stale" : "wall-body"}>
      <header className="wall-head">
        <div className="wall-heading"><h1>{w.title}</h1><p className="wall-meta muted">{w.lead}</p></div>
        <div className="wall-kpis" aria-live="polite">{kpis.map(kpi => <p key={kpi.key} className={`wall-kpi tone-${kpi.tone}`} data-testid={`wall-${kpi.key}`}><strong className="mono" dir="ltr">{kpi.value}</strong><span>{kpi.label}</span>
          {kpi.key === "overdue" && overdueTime(snapshot.oldest_overdue_acknowledgement_at, now) && <small>{t.oldestOverdue.replace("{time}", overdueTime(snapshot.oldest_overdue_acknowledgement_at, now)!)}</small>}</p>)}</div>
        <time className="wall-clock mono" dir="ltr" data-testid="wall-clock" dateTime={new Date(now).toISOString()}>{wallMinutes(now)}</time>
      </header>
      {!shown.length ? <section className="wall-empty" data-testid="wall-empty"><p className="wall-title">{w.empty}</p><p className="wall-meta muted">{w.emptyBody}</p></section>
        : <ol key={page} className="wall-grid" aria-label={w.tilesLabel}>{shown.map(item => <WallTile key={item.id} item={item} now={now} locale={locale} />)}</ol>}
      {hidden > 0 && <p className="wall-meta wall-more" data-testid="wall-more">{d.more.replace("{n}", String(hidden))}{pages > 1 && !still && <> · <span>{w.page.replace("{page}", String(page + 1)).replace("{pages}", String(pages))}</span></>}</p>}
      {uploads.length > 0 && <section className="wall-now" aria-labelledby="wall-now-title">
        <p className="wall-title" id="wall-now-title"><span className="live-dot" aria-hidden="true" /> {t.inboxNow} <span className="wall-meta">{d.uploading.replace("{n}", String(uploads.length))}</span></p>
        <ul>{uploads.slice(0, uploadSlots).map(u => {
          const percent = Math.floor((u.bytes_received / u.size_bytes) * 100);
          return <li key={u.upload_session_id} className={u.priority} data-testid="wall-upload"><p className="wall-meta">{t.kinds[u.kind]} · {m.states.priority[u.priority]} · <bdi dir="ltr">{percent}%</bdi></p>
            <div className="wall-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t.kinds[u.kind]}><span style={{ inlineSize: `${percent}%` }} /></div></li>;
        })}{uploads.length > uploadSlots && <li className="wall-more">{d.more.replace("{n}", String(uploads.length - uploadSlots))}</li>}</ul>
      </section>}
      <footer className="wall-foot wall-meta"><p className="muted">{d.privacy}</p><p data-testid="wall-sound"><span aria-hidden="true">{sound ? "🔔" : "🔕"}</span> {sound ? d.soundOn : d.soundOff}</p></footer>
    </div>
  </div>;
}

/** بلاطة الجدار (`Web/Wall tile`، Urgent = No · Yes): المحافظة والزمن منذ الوصول، والعنوان، والمصوّر والنوع والمدة، والحالة. العاجل حدّ وكلمة. */
function WallTile({ item, now, locale }: { item: Material; now: number; locale: Locale }) {
  const m = messages[locale], w = m.board.wall, urgent = item.priority === "urgent", type = item.material_types[0] ? (m.types as Record<string, string>)[item.material_types[0]] : null;
  const duration = mediaDuration(item.files.find(file => file.kind === "original")?.duration_ms), overdue = overdueTime(item.acknowledgement_due_at, now);
  return <li className={`wall-tile${urgent ? " urgent" : ""}`} data-testid="wall-card">
    <p className="tile-top"><span className="wall-place">{item.governorate}</span><span className={urgent ? "tile-age danger-text" : "tile-age"}>{urgent && <span className="visually-hidden">{m.states.priority.urgent} · </span>}{w.since.replace("{time}", humanDuration(now - Date.parse(item.created_at), locale))}</span></p>
    <p className="tile-title">{item.title}</p>
    <p className="tile-meta"><span>{[photographer(item, locale), [type, duration].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}</span>
      <span>{m.states.editorial_state[item.editorial_state]} · {item.acknowledged_at ? w.received : w.notReceived}</span></p>
    {overdue && <p className="tile-meta danger-text" data-testid="ack-overdue">{w.ackOverdue.replace("{time}", overdue)}</p>}
  </li>;
}
