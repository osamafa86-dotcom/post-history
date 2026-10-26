"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Form, Material, TransitionRecord } from "@/lib/types";
import { lastEvents, timecode, timeline, type Track } from "@/lib/editor";
import { stateColumn, tracks } from "@/lib/review";
import { useUser } from "./session-boundary";
import { photographer, StateBadge } from "./states";
import { DynamicForm } from "./dynamic-form";
import { MediaPreview } from "./media-preview";
import { ReviewActions } from "./review-actions";
import { ListingPanel } from "./listing-panel";
import { materialTag } from "@/lib/review";

/** تفاصيل المادة (B2): ثلاث بطاقات حالة مستقلة بلون مسارها، والمشغّل والبيانات، والخط الزمني الموحّد بجانبها. */
export function MaterialDetail({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], me = useUser(), [material, setMaterial] = useState<Material | null>(null), [schema, setSchema] = useState<Form | null>(null), [error, setError] = useState(0), [attempt, setAttempt] = useState(0);
  const editing = useRef(false), [tag, setTag] = useState<string | null>(null);
  const [toast, setToast] = useState(""), [records, setRecords] = useState<TransitionRecord[] | null>(null), [historyFailed, setHistoryFailed] = useState(false), [filter, setFilter] = useState<Track | null>(null);
  function reload() { editing.current = false; setMaterial(null); setAttempt(n => n + 1); }
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function load() {
      if (editing.current) { timer = setTimeout(load, 15000); return; }
      try {
        const result = await browserApi().GET("/materials/{id}", { params: { path: { id } }, signal: controller.signal });
        const data = dataOrThrow(result);
        const form = await browserApi().GET("/forms/{version}", { params: { path: { version: data.form_version } }, signal: controller.signal });
        if (form.response.status !== 404) dataOrThrow(form);
        if (!controller.signal.aborted && !editing.current) { setMaterial(data); setTag(materialTag(result.response, data)); setSchema(form.data ?? null); setError(0); }
      } catch (e) { if (!controller.signal.aborted && !editing.current) { setError(e instanceof RequestError ? e.status : 503); setMaterial(null); setSchema(null); } }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000); }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer); };
  }, [id, attempt]);
  // التوست ثماني ثوانٍ (المواصفة B3)، على مستوى الصفحة كي يبقى بعد إعادة التحميل.
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 8000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/materials/{id}/transitions", { params: { path: { id } }, signal: controller.signal }).then(result => { const data = dataOrThrow(result); if (!controller.signal.aborted) { setRecords(data.items); setHistoryFailed(false); } }).catch(() => { if (!controller.signal.aborted) setHistoryFailed(true); });
    return () => controller.abort();
  }, [id, attempt]);

  const back = <Link prefetch={false} className="back-link" href={`/${locale}/inbox`}>{m.back}</Link>;
  if (error) return <>{back}<section className="center-state" role="alert"><p>{error === 404 ? m.notFound : error === 403 ? m.material.outOfScope : m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section></>;
  if (!material) return <>{back}<p className="center-state" role="status">{m.loading}</p></>;
  const receipt = material.files.find(f => f.receipt_number)?.receipt_number, last = lastEvents(records ?? []), names = { technical: m.technical, editorial: m.editorial, rights: m.rights };
  return <>{back}{toast && <p className="toast" role="status">{m.review.transitioned.replace("{state}", toast)}</p>}
    <div className="page-heading material-heading"><div><p className="caption">{m.version} {material.version} · <bdi dir="ltr">{receipt ?? m.noReceipt}</bdi>{material.acknowledged_at && <> · {m.material.acknowledged} {formatDate(material.acknowledged_at, locale)}</>} <span className={`badge ${material.priority === "urgent" ? "urgent" : ""}`}>{m.states.priority[material.priority]}</span></p><h1>{material.title}</h1></div></div>
    <div className="state-grid">{tracks.map(track => <button type="button" key={track} className={`state-card track-${track}`} aria-pressed={filter === track} onClick={() => setFilter(current => current === track ? null : track)}>
      <span className="state-card-title">{names[track]}</span><StateBadge track={stateColumn[track]} value={material[stateColumn[track]]} locale={locale} />
      <small className="muted">{last[track] ? `${formatDate(last[track]!.occurred_at, locale)}` : m.material.noEvent}</small></button>)}</div>
    <div className="detail-grid">
      <div className="detail-main"><MediaPreview locale={locale} material={material} />
        <section className="card"><h2>{m.details}</h2><dl className="metadata">{[[m.photographer, photographer(material, locale)], [m.governorate, material.governorate], [m.city, material.city], [m.shotAt, formatDate(material.shot_at, locale)], [m.createdAt, formatDate(material.created_at, locale)], [m.receipt, receipt ?? m.noReceipt], [m.formVersion, material.form_version]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        <section className="card"><h2>{m.dynamicData}</h2>{material.redacted_field_keys?.length ? <p className="notice locked">{m.hiddenFields}</p> : null}{schema && Object.keys(material.dynamic_fields).length ? <DynamicForm key={`${material.id}-${material.updated_at}`} schema={schema} type={material.material_types[0]} permissions={me.permissions} locale={locale} initialValues={material.dynamic_fields} readOnly /> : <p className="muted">{schema ? m.noDynamic : m.formMissing}</p>}</section>
        <ReviewActions key={`${material.id}:${tag}`} locale={locale} material={material} tag={tag} editing={() => { editing.current = true; }} reload={reload} notify={setToast} /><ListingPanel key={`${material.id}:listing:${material.rights_state}`} locale={locale} material={material} />
      </div>
      <Timeline locale={locale} records={records} failed={historyFailed} filter={filter} clear={() => setFilter(null)} />
    </div>
  </>;
}

/** الخط الزمني: الأحداث تنازليًا، كل حدث بلون مساره؛ السبب يظهر لمن يعيده الـBFF وحده (صاحب المادة). */
function Timeline({ locale, records, failed, filter, clear }: { locale: Locale; records: TransitionRecord[] | null; failed: boolean; filter: Track | null; clear: () => void }) {
  const m = messages[locale], names = { technical: m.technical, editorial: m.editorial, rights: m.rights };
  const label = (record: TransitionRecord, value: string) => (m.states[stateColumn[record.track as Track]] as Record<string, string>)[value] ?? value;
  const items = records ? timeline(records, filter) : null;
  return <section className="card timeline" aria-labelledby="timeline-title"><div className="timeline-head"><h2 id="timeline-title">{m.review.history}</h2>{filter && <button type="button" className="quiet" onClick={clear}>{m.material.allTracks} · {names[filter]}</button>}</div>
    {failed ? <p role="alert">{m.error}</p> : items === null ? <p role="status">{m.loading}</p> : !items.length ? <p className="muted">{m.review.noHistory}</p>
      : <ol className="history-list">{items.map(item => <li key={item.id} className={`track-${item.track}`}>
        <span className="timeline-dot" aria-hidden="true" />
        <p><strong>{names[item.track as Track] ?? item.track}</strong>: {label(item, item.from)} {locale === "ar" ? "←" : "→"} {label(item, item.to)}{item.note_timecode_ms != null && <span className="time-chip" dir="ltr">{timecode(item.note_timecode_ms)}</span>}</p>
        {item.reason && <blockquote className="supervisor-note"><p>{m.review.note}: «{item.reason}»</p></blockquote>}
        <p className="caption">{formatDate(item.occurred_at, locale)} · {m.review.actor}: <bdi>{item.actor_id ? item.actor_id.slice(0, 8) : m.material.system}</bdi></p></li>)}</ol>}
  </section>;
}
