"use client";
import { useState } from "react";
import type { Field, Form, MaterialType, Permission, Values } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { validate, visibleFields } from "@/lib/forms";

function dateInput(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
function FieldInput({ field, value, change, locale, invalid }: { field: Field; value: unknown; change: (value: unknown) => void; locale: Locale; invalid: boolean }) {
  const m = messages[locale], id = `field-${field.key}`, common = { id, "aria-invalid": invalid, "aria-describedby": `${id}-help ${id}-error` };
  switch (field.type) {
    case "short_text": case "staff_member": return <input {...common} value={typeof value === "string" ? value : ""} dir={field.type === "staff_member" ? "ltr" : undefined} onChange={e => change(e.target.value)} />;
    case "long_text": return <textarea {...common} rows={4} value={typeof value === "string" ? value : ""} onChange={e => change(e.target.value)} />;
    case "number": return <input {...common} type="number" step="any" value={typeof value === "number" ? value : ""} onChange={e => change(e.target.value === "" ? null : e.target.valueAsNumber)} />;
    case "datetime": return <input {...common} type="datetime-local" step="1" value={dateInput(value)} onChange={e => change(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case "boolean": return <select {...common} value={value === true ? "true" : value === false ? "false" : ""} onChange={e => change(e.target.value === "" ? null : e.target.value === "true")}><option value="">{m.choose}</option><option value="true">{m.yes}</option><option value="false">{m.no}</option></select>;
    case "select": return <select {...common} value={typeof value === "string" ? value : ""} onChange={e => change(e.target.value)}><option value="">{m.choose}</option>{field.validation?.options?.map(o => <option value={o.value} key={o.value}>{o.label[locale]}</option>)}</select>;
    case "multi_select": return <select {...common} multiple value={Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []} onChange={e => change(Array.from(e.target.selectedOptions).map(o => o.value))}>{field.validation?.options?.map(o => <option value={o.value} key={o.value}>{o.label[locale]}</option>)}</select>;
    case "attachment": return <input {...common} type="file" multiple accept={field.validation?.accept?.join(",")} onChange={e => change(Array.from(e.target.files ?? []).map(f => ({ mime: f.type, size_bytes: f.size })))} />;
    case "location": return <p id={id}>{m.locationUnavailable}</p>;
  }
}

export function DynamicForm({ schema, type, permissions, locale, initialValues, readOnly = false }: { schema: Form; type: MaterialType; permissions: Permission[]; locale: Locale; initialValues?: Values; readOnly?: boolean }) {
  const m = messages[locale];
  const [values, setValues] = useState<Values>(() => initialValues ?? Object.fromEntries(schema.fields.filter(f => f.default !== undefined).map(f => [f.key, f.default])));
  const [submitted, setSubmitted] = useState(false);
  const fields = visibleFields(schema, type, values, permissions), result = validate(schema, type, values, permissions);
  if (readOnly) return <dl className="dynamic-values">{fields.filter(f => values[f.key] !== undefined && values[f.key] !== null).map(field => <div key={field.key}><dt>{field.label[locale]}</dt><dd><ReadValue value={values[field.key]} field={field} locale={locale} /></dd></div>)}</dl>;
  return <form className="dynamic-form" noValidate onSubmit={e => { e.preventDefault(); setSubmitted(true); }}>
    {fields.map(field => {
      const code = submitted ? result.errors.find(error => error.field === field.key)?.code : undefined;
      const hint = field.help?.[locale] ?? (field.type === "datetime" ? m.datetimeHelp : field.type === "attachment" ? m.attachmentHelp : field.type === "staff_member" ? m.staffHelp : "");
      return <div className="dynamic-field" key={field.key}><label htmlFor={`field-${field.key}`}>{field.label[locale]}{field.required && <small className="required-label">{m.required}</small>}</label><FieldInput field={field} value={values[field.key]} change={value => setValues(current => ({ ...current, [field.key]: value }))} locale={locale} invalid={Boolean(code)} /><small className="muted" id={`field-${field.key}-help`}>{hint}</small><span className="field-error" id={`field-${field.key}-error`}>{code && m.validation[code]}</span></div>;
    })}
    <button>{m.validate}</button>{submitted && <p className={`notice ${result.valid ? "" : "error"}`} role="status">{result.valid ? m.formValid : m.formInvalid}</p>}
  </form>;
}
function ReadValue({ value, field, locale }: { value: unknown; field: Field; locale: Locale }) {
  const m = messages[locale];
  if (field.type === "attachment") return <>{m.selectedFiles}: {Array.isArray(value) ? value.length : 0}</>;
  if (field.type === "location") return <>{m.locationUnavailable}</>;
  if (field.type === "boolean") return <>{value === true ? m.yes : value === false ? m.no : m.notAvailable}</>;
  if (field.type === "select" || field.type === "multi_select") return <>{(Array.isArray(value) ? value : [value]).map(x => field.validation?.options?.find(o => o.value === x)?.label[locale]).filter(Boolean).join(" · ") || m.notAvailable}</>;
  return <>{typeof value === "string" || typeof value === "number" ? value : m.notAvailable}</>;
}
