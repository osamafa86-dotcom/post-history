"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import type { Form, Material } from "@/lib/types";
import { useUser } from "./session-boundary";
import { photographer, StateBadge } from "./states";
import { DynamicForm } from "./dynamic-form";
import { MediaPreview } from "./media-preview";
import { ReviewActions } from "./review-actions";
import { ListingPanel } from "./listing-panel";
import { materialTag } from "@/lib/review";

export function MaterialDetail({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], me = useUser(), [material, setMaterial] = useState<Material | null>(null), [schema, setSchema] = useState<Form | null>(null), [error, setError] = useState(0), [attempt, setAttempt] = useState(0);
  const editing = useRef(false), [tag, setTag] = useState<string | null>(null);
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
  return <><Link prefetch={false} className="back-link" href={`/${locale}/inbox`}>{m.back}</Link>{error ? <section className="center-state" role="alert"><p>{error === 404 ? m.notFound : m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section> : !material ? <p className="center-state" role="status">{m.loading}</p> : <><div className="page-heading"><div><p className="eyebrow">{m.details}</p><h1>{material.title}</h1><p className="muted">{m.version} {material.version}</p></div></div><div className="state-grid">{(["technical_state", "editorial_state", "rights_state"] as const).map((track, i) => <article key={track}><p>{[m.technical, m.editorial, m.rights][i]}</p><StateBadge track={track} value={material[track]} locale={locale} /></article>)}</div>
      <div className="detail-grid"><MediaPreview locale={locale} material={material} /><section className="card"><h2>{m.details}</h2><dl className="metadata">{[[m.photographer, photographer(material, locale)], [m.governorate, material.governorate], [m.city, material.city], [m.shotAt, formatDate(material.shot_at, locale)], [m.createdAt, formatDate(material.created_at, locale)], [m.receipt, material.files.find(f => f.receipt_number)?.receipt_number ?? m.noReceipt], [m.formVersion, material.form_version]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section></div>
      <section className="card"><h2>{m.dynamicData}</h2>{material.redacted_field_keys?.length ? <p className="notice">{m.hiddenFields}</p> : null}{schema && Object.keys(material.dynamic_fields).length ? <DynamicForm key={`${material.id}-${material.updated_at}`} schema={schema} type={material.material_types[0]} permissions={me.permissions} locale={locale} initialValues={material.dynamic_fields} readOnly /> : <p className="muted">{schema ? m.noDynamic : m.formMissing}</p>}</section>
      <ReviewActions key={`${material.id}:${tag}`} locale={locale} material={material} tag={tag} editing={() => { editing.current = true; }} reload={reload} /><ListingPanel key={`${material.id}:listing:${material.rights_state}`} locale={locale} material={material} /></> }</>;
}
