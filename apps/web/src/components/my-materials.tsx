"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Material, TransitionRecord } from "@/lib/types";
import { states } from "@/lib/query";
import { useUser } from "./session-boundary";
import { StateBadge } from "./states";

// ما يحتاج المراسل أن يفعل فيه شيئًا: طلب تعديل من المشرف، أو رفع فشل ويُعاد.
export const needsAction = (material: Material) => material.editorial_state === "needs_changes" || material.technical_state === "failed";
// حد طلبات الملاحظات في الدورة الواحدة؛ ما زاد يفتحه المراسل من صفحة المادة.
const noteLimit = 10;
export function timecode(ms: number) {
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), mm = String(Math.floor(total / 60) % 60).padStart(2, "0"), ss = String(total % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
/** آخر ملاحظة مكتوبة على طلب تعديل أو رفض؛ الخادم لا يرسل السبب إلا لصاحب المادة. */
export function latestNote(items: TransitionRecord[]) {
  return items.filter(item => item.track === "editorial" && (item.to === "needs_changes" || item.to === "rejected") && item.reason).sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0] ?? null;
}

export function MyMaterials({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.mine, me = useUser();
  const [items, setItems] = useState<Material[] | null>(null), [more, setMore] = useState(false), [notes, setNotes] = useState<Record<string, TransitionRecord | null>>({}), [error, setError] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const page = dataOrThrow(await browserApi().GET("/materials", { params: { query: { reporter_id: me.user_id, limit: 100 } }, signal: controller.signal }));
        const pending = page.items.filter(item => item.editorial_state === "needs_changes" || item.editorial_state === "rejected").slice(0, noteLimit);
        const found = Object.fromEntries(await Promise.all(pending.map(async item => {
          try { return [item.id, latestNote(dataOrThrow(await browserApi().GET("/materials/{id}/transitions", { params: { path: { id: item.id } }, signal: controller.signal })).items)] as const; }
          catch { return [item.id, null] as const; }
        })));
        if (!disposed) { setItems(page.items); setMore(!!page.next_cursor); setNotes(found); setError(false); }
      } catch { if (!disposed && !controller.signal.aborted) setError(true); }
      finally { if (!disposed) timer = setTimeout(load, 30000); }
    }
    void load();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [me.user_id, refresh]);
  const action = items?.filter(needsAction) ?? [];
  return <>
    <div className="page-heading"><div><p className="eyebrow">{m.workspace}</p><h1>{t.title}</h1><p className="muted">{t.lead}</p></div><button className="secondary" onClick={() => setRefresh(n => n + 1)}>{m.refresh}</button></div>
    {error && <p className="notice" role="status">{items ? m.stale : m.error}</p>}
    {!items ? !error && <p className="center-state" role="status">{m.loading}</p> : <>
      <section className="stats mine-stats" aria-label={t.counts}>{states.editorial_state.map(state => <article key={state} data-state={state}><span>{m.states.editorial_state[state]}</span><strong>{items.filter(item => item.editorial_state === state).length}</strong></article>)}</section>
      {more && <p className="muted">{t.firstPage}</p>}
      <section className="card" aria-labelledby="mine-action"><h2 id="mine-action">{t.action}</h2>{!action.length ? <p className="muted">{t.noAction}</p> : <ul className="mine-list">{action.map(item => <li key={item.id} data-testid="mine-action">
        <Link className="material-link" prefetch={false} href={`/${locale}/materials/${item.id}`}>{item.title}</Link>
        <p>{item.technical_state === "failed" ? t.uploadFailed : t.changesRequested}</p>
        <Note note={notes[item.id]} locale={locale} />
      </li>)}</ul>}</section>
      <section className="table-panel" aria-label={t.all}>{!items.length ? <p className="empty">{t.empty}</p> : <div className="table-scroll"><table><thead><tr>{[m.title, m.receipt, m.createdAt, m.technical, m.editorial, m.rights, t.note].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead><tbody>{items.map(item => <tr key={item.id} data-testid="mine-row">
        <td><Link className="material-link" prefetch={false} href={`/${locale}/materials/${item.id}`}>{item.title}</Link></td>
        <td className="receipt" dir="ltr">{item.files.find(f => f.receipt_number)?.receipt_number ?? m.noReceipt}</td>
        <td>{formatDate(item.created_at, locale)}</td>
        {(["technical_state", "editorial_state", "rights_state"] as const).map(track => <td key={track}><StateBadge track={track} value={item[track]} locale={locale} /></td>)}
        <td>{item.editorial_state === "rejected" ? <Note note={notes[item.id]} locale={locale} /> : null}</td>
      </tr>)}</tbody></table></div>}</section>
    </>}
  </>;
}

function Note({ note, locale }: { note: TransitionRecord | null | undefined; locale: Locale }) {
  const t = messages[locale].mine;
  if (!note) return <p className="muted">{t.openForNote}</p>;
  return <blockquote className="supervisor-note" data-testid="supervisor-note"><p>{note.reason}</p><footer>{note.note_timecode_ms != null && <span>{t.at} <bdi dir="ltr">{timecode(note.note_timecode_ms)}</bdi> · </span>}{formatDate(note.occurred_at, locale)}</footer></blockquote>;
}
