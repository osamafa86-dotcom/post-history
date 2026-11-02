"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, plural, shortTime, type Locale } from "@/lib/i18n";
import type { Form, Material, TransitionRecord } from "@/lib/types";
import { internalNames } from "@/lib/work-name";
import { lastEvents, timecode, timeline, type Track } from "@/lib/editor";
import { stateColumn, tracks } from "@/lib/review";
import { useUser } from "./session-boundary";
import { photographer, StateBadge } from "./states";
import { DynamicForm } from "./dynamic-form";
import { MediaPreview } from "./media-preview";
import { Contributors, ReviewActions } from "./review-actions";
import { ListingPanel } from "./listing-panel";
import { EmptyState } from "./empty-state";
import { Icon } from "./icon";
import { materialTag } from "@/lib/review";

/**
 * تفاصيل المادة (W2، والجوال M2): المشغّل والعنوان وسطر الوصف والوسوم وسطر الحساسية في العمود الرئيسي، والحالات الثلاث (أزرار تصفّي السجل)
 * والخطوة التالية والسجل في العمود الجانبي. المكان المحافظة والمدينة وحدهما (حقلا العقد)؛ إحداثيات GPS لا تُقرأ ولا تُعرض أبدًا (ADR 0087).
 */
export function MaterialDetail({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], w = m.shell.material, me = useUser(), [material, setMaterial] = useState<Material | null>(null), [schema, setSchema] = useState<Form | null>(null), [error, setError] = useState(0), [attempt, setAttempt] = useState(0);
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

  const crumbs = (title?: string) => <nav className="breadcrumb" aria-label={w.breadcrumb}><Link prefetch={false} className="back-link" href={`/${locale}/inbox`} aria-label={m.back}>{m.inbox}</Link>{title && <><span aria-hidden="true">‹</span><span aria-current="page">{title}</span></>}</nav>;
  if (error) return <>{crumbs()}<EmptyState icon={error === 403 ? "key" : error === 404 ? "search" : "alert"} role="alert" title={error === 404 ? m.notFound : error === 403 ? m.material.outOfScope : m.error} actions={<button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} /></>;
  if (!material) return <>{crumbs()}<p className="visually-hidden" role="status">{m.loading}</p><div className="material-layout" aria-hidden="true"><div className="material-main"><span className="skeleton media" /><span className="skeleton line wide" /><span className="skeleton line" /></div><div className="material-side"><span className="skeleton card" /><span className="skeleton card" /></div></div></>;
  const receipt = material.files.find(f => f.receipt_number)?.receipt_number, last = lastEvents(records ?? []), names = { technical: m.technical, editorial: m.editorial, rights: m.rights };
  const files = material.files.filter(f => f.kind === "original").length, time = shortTime(material.shot_at);
  const flags = (["minors", "injured", "graphic"] as const).filter(flag => material.sensitivity?.[flag]);
  return <>{crumbs(material.title)}{toast && <p className="toast" role="status">{m.review.transitioned.replace("{state}", toast)}</p>}
    <div className="material-layout">
      <div className="material-main">
        <MediaPreview locale={locale} material={material} />
        <div className="material-title"><h1>{material.title}</h1>{material.priority !== "normal" && <span className={`priority-pill ${material.priority}`}>{material.priority === "urgent" && <Icon name="bolt" size={12} />}{m.states.priority[material.priority]}</span>}</div>
        <p className="material-meta"><span>{photographer(material, locale)}</span><span>{material.governorate}</span><span>{material.city}</span>{time && <span>{w.shot} <bdi dir="ltr">{time}</bdi></span>}{material.material_types.map(type => <span key={type}>{(m.types as Record<string, string>)[type] ?? type}</span>)}{files > 0 && <span>{plural(files, m.shell.inbox.files, locale)}</span>}<span>{m.version} <bdi dir="ltr">{material.version}</bdi></span><span className="receipt"><bdi dir="ltr">{receipt ?? m.noReceipt}</bdi></span>{material.acknowledged_at && <span>{m.material.acknowledged} {formatDate(material.acknowledged_at, locale)}</span>}</p>
        {material.tags?.length ? <ul className="tag-list large" aria-label={m.shell.inbox.tags}>{material.tags.map(tag => <li key={tag}><bdi>{tag}</bdi></li>)}</ul> : null}
        <p className={`sensitivity-line${flags.length ? " flagged" : ""}`} data-testid="sensitivity-line"><Icon name="shield" size={18} /><span><strong>{w.sensitivity}: </strong>{flags.length ? <>{flags.map(flag => m.upload[flag]).join(m.shell.listSeparator)} — {w.sensitiveRule}</> : w.notSensitive}</span></p>
        <section className="card"><h2>{m.details}</h2><dl className="metadata">{[[m.photographer, photographer(material, locale)], [m.governorate, material.governorate], [m.city, material.city], [m.shotAt, formatDate(material.shot_at, locale)], [m.createdAt, formatDate(material.created_at, locale)], [m.receipt, receipt ?? m.noReceipt], [m.formVersion, material.form_version]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
        <section className="card"><h2>{m.dynamicData}</h2>{material.redacted_field_keys?.length ? <p className="notice locked">{m.hiddenFields}</p> : null}{schema && Object.keys(material.dynamic_fields).length ? <DynamicForm key={`${material.id}-${material.updated_at}`} schema={schema} type={material.material_types[0]} permissions={me.permissions} locale={locale} initialValues={material.dynamic_fields} readOnly /> : <p className="muted">{schema ? m.noDynamic : m.formMissing}</p>}</section>
        <ListingPanel key={`${material.id}:listing:${material.rights_state}`} locale={locale} material={material} />
        <Contributors key={`${material.id}:contributors:${tag}`} locale={locale} material={material} tag={tag} editing={() => { editing.current = true; }} reload={reload} />
      </div>
      <div className="material-side">
        <section className="card states-card" aria-labelledby="states-title"><h2 id="states-title">{w.states}</h2>
          <div className="state-grid">{tracks.map(track => <button type="button" key={track} className={`state-card track-${track}`} aria-pressed={filter === track} onClick={() => setFilter(current => current === track ? null : track)}>
            <span className="state-card-text"><span className="state-card-title">{names[track]}</span><small>{last[track] ? `${formatDate(last[track]!.occurred_at, locale)}` : m.material.noEvent}</small></span>
            <StateBadge track={stateColumn[track]} value={material[stateColumn[track]]} locale={locale} /></button>)}</div>
          <p className="caption">{w.statesHelp}</p></section>
        <ReviewActions key={`${material.id}:${tag}`} locale={locale} material={material} tag={tag} editing={() => { editing.current = true; }} reload={reload} notify={setToast} />
        <Timeline internal={internalNames(me)} locale={locale} records={records} failed={historyFailed} filter={filter} clear={() => setFilter(null)} />
      </div>
    </div>
  </>;
}

/** السجل: الأحداث تنازليًا، كل حدث بلون مساره؛ السبب يظهر لمن يعيده الـBFF وحده (صاحب المادة). */
function Timeline({ internal, locale, records, failed, filter, clear }: { internal: boolean; locale: Locale; records: TransitionRecord[] | null; failed: boolean; filter: Track | null; clear: () => void }) {
  const m = messages[locale], names = { technical: m.technical, editorial: m.editorial, rights: m.rights };
  const label = (record: TransitionRecord, value: string) => (m.states[stateColumn[record.track as Track]] as Record<string, string>)[value] ?? value;
  const items = records ? timeline(records, filter) : null;
  return <section className="card timeline" aria-labelledby="timeline-title"><div className="timeline-head"><h2 id="timeline-title">{m.review.history}</h2>{filter && <button type="button" className="quiet" onClick={clear}>{m.material.allTracks} · {names[filter]}</button>}</div>
    {failed ? <p role="alert">{m.error}</p> : items === null ? <p role="status">{m.loading}</p> : !items.length ? <p className="muted">{m.review.noHistory}</p>
      : <ol className="history-list">{items.map(item => <li key={item.id} className={`track-${item.track}`}>
        <span className="timeline-dot" aria-hidden="true" />
        <p><strong>{names[item.track as Track] ?? item.track}</strong>: {label(item, item.from)} {locale === "ar" ? "←" : "→"} {label(item, item.to)}{item.note_timecode_ms != null && <span className="time-chip" dir="ltr">{timecode(item.note_timecode_ms)}</span>}</p>
        {item.reason && <blockquote className="supervisor-note"><p>{m.review.note}: «{item.reason}»</p></blockquote>}
        <p className="caption">{formatDate(item.occurred_at, locale)} · {m.review.actor}: <bdi>{internal && item.actor_name ? item.actor_name : m.material.neutralActor}</bdi></p></li>)}</ol>}
  </section>;
}
