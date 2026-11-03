"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import type { Form, MaterialType } from "@/lib/types";
import { materialTypes } from "@/lib/query";
import { useUser } from "./session-boundary";
import { DynamicForm } from "./dynamic-form";
import { EmptyState } from "./empty-state";
import { Icon } from "./icon";
export function FormPreview({ locale }: { locale: Locale }) {
  const m = messages[locale], me = useUser(), [type, setType] = useState<MaterialType>("report"), [schema, setSchema] = useState<Form | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/forms/current", { params: { query: { material_type: type } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setSchema(data); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [type, attempt]);
  // معاينة النموذج بهيكل v2 (ADR 0103): رأس الصفحة، والنوع، ثم النموذج للقراءة؛ والتحميل هيكل والخطأ بسببه وفعله.
  return <><div className="page-head"><div><h1>{m.formPreview}</h1><p className="muted">{m.formLead}</p></div><span className="badge state muted"><Icon name="preview" size={14} />{m.readOnly}</span></div>
    <section className="card form-card"><label>{m.materialType}<select value={type} onChange={e => { setSchema(null); setType(e.target.value as MaterialType); }}>{materialTypes.map(t => <option key={t} value={t}>{m.types[t]}</option>)}</select></label>
      {error ? <EmptyState icon="form" role="alert" title={m.formMissing} actions={<button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button>} />
        : schema ? <><p className="caption">{m.version} <bdi dir="ltr" className="ref">{schema.version}</bdi></p><DynamicForm key={`${type}-${schema.version}`} schema={schema} type={type} permissions={me.permissions} locale={locale} /></>
        : <><p className="visually-hidden" role="status">{m.loading}</p><span className="skeleton block" aria-hidden="true" /><span className="skeleton card" aria-hidden="true" /></>}</section></>;
}
