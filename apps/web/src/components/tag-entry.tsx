"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { codePoints, fill, stripHidden } from "@/lib/admin-text";
import { suggestionReaders, tagLimits, validTag } from "@/lib/tag-policy";
import { useUser } from "./session-boundary";
import { Icon } from "./icon";

/**
 * إدخال وسوم المادة (ADR 0086): حتى 12 وسمًا صالحًا بلا تكرار، يُضاف الوسم بالزر أو Enter ويُزال من رقاقته. المقترحة من قائمة الإدارة
 * ملء أسرع لا قيد، وتُجلب لمن يقرؤها. قاعدة واحدة حيث تُكتب الوسوم: تعديل وسوم المادة (W2) والرفع من الحاسوب.
 */
export function TagEntry({ locale, tags, onChange }: { locale: Locale; tags: string[]; onChange: (tags: string[]) => void }) {
  const t = messages[locale].shell.material.tagEditor, me = useUser();
  const [text, setText] = useState(""), [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (!hasRole(me, ...suggestionReaders)) return;
    const controller = new AbortController();
    void browserApi().GET("/tag-suggestions", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) setSuggestions(data.tags); }).catch(() => undefined);
    return () => controller.abort();
  }, [me]);
  const value = text.trim(), full = tags.length >= tagLimits.perMaterial;
  const addable = validTag(value) && !tags.includes(value) && !full, invalid = !!value && !addable && !full;
  function add(next: string) { if (validTag(next) && !tags.includes(next) && !full) { onChange([...tags, next]); setText(""); } }
  return <>
    {tags.length ? <ul className="tag-list large editable">{tags.map(item => <li key={item}><button type="button" className="chip removable" aria-label={fill(t.remove, { tag: item })} onClick={() => onChange(tags.filter(other => other !== item))}><bdi>{item}</bdi><Icon name="x" size={14} /></button></li>)}</ul> : <p className="muted">{t.none}</p>}
    <div className="tag-add"><label>{t.add}<input value={text} maxLength={tagLimits.tag * 2} dir="auto" aria-invalid={invalid} aria-describedby="tag-add-hint" disabled={full} onChange={event => setText(stripHidden(event.target.value))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (addable) add(value); } }} /></label>
      <button type="button" className="secondary small" disabled={!addable} onClick={() => add(value)}>{t.addButton}</button></div>
    <small id="tag-add-hint" className={invalid || full ? "field-hint error" : "field-hint"} role="status">{full ? t.max : invalid ? t.invalid : fill(t.counter, { n: codePoints(value) })}</small>
    {suggestions.some(item => !tags.includes(item)) && <div className="tag-suggested"><p className="caption">{t.suggested}</p>
      <ul className="tag-list">{suggestions.filter(item => !tags.includes(item)).slice(0, 12).map(item => <li key={item}><button type="button" className="chip" disabled={full} onClick={() => add(item)}><Icon name="plus" size={12} /><bdi>{item}</bdi></button></li>)}</ul></div>}
  </>;
}
