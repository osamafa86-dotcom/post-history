"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { codePoints, fill, stripHidden } from "@/lib/admin-text";
import { materialTagEditors, materialTagsInput, suggestionReaders, tagLimits, validTag } from "@/lib/tag-policy";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { ConfirmDialog } from "./admin-parts";
import { Icon } from "./icon";

/**
 * وسوم المادة في W2 (ADR 0086، 0104، 0105): العرض للجميع كما كان، والتعديل للمشرف في نطاقه ولرئيس التحرير. الحفظ استبدال كامل على
 * `PUT /materials/{id}/tags` بإصدار الصف الحالي (If-Match) ومفتاح منع التكرار، بعد تأكيد يقول أثره. 412: تغيّرت المادة، فيُعاد التحميل
 * ويقول السطر ذلك. المقترحة من قائمة الإدارة ملء أسرع لا قيد. نص الوسم لا يدخل حدثًا ولا تدقيقًا (يحكم فيه الخادم).
 */
export type TagNotice = "saved" | "stale" | "";
/** `notice` يعيش في الصفحة: إعادة التحميل تعيد رسم المادة كلها، والسطر يبقى بعدها. */
export function MaterialTags({ locale, material, tag, notice, setNotice, editing, release, reload }: { locale: Locale; material: Material; tag: string | null; notice: TagNotice; setNotice: (notice: TagNotice) => void; editing: () => void; release: () => void; reload: () => void }) {
  const m = messages[locale], t = m.shell.material.tagEditor, me = useUser(), mutation = useMutation(), editor = hasRole(me, ...materialTagEditors);
  const [draft, setDraft] = useState<string[] | null>(null), [text, setText] = useState(""), [confirming, setConfirming] = useState(false), [suggestions, setSuggestions] = useState<string[]>([]);
  const current = material.tags ?? [], open = draft !== null;
  useEffect(() => {
    if (!open || !hasRole(me, ...suggestionReaders)) return;
    const controller = new AbortController();
    void browserApi().GET("/tag-suggestions", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) setSuggestions(data.tags); }).catch(() => undefined);
    return () => controller.abort();
  }, [open, me]);
  const value = text.trim(), full = !!draft && draft.length >= tagLimits.perMaterial;
  const addable = !!draft && validTag(value) && !draft.includes(value) && !full, invalid = !!value && !addable && !full;
  const changed = !!draft && (draft.length !== current.length || draft.some((item, i) => item !== current[i]));
  function start() { editing(); mutation.clearStatus(); setNotice(""); setDraft([...current]); setText(""); }
  function add(next: string) { if (draft && validTag(next) && !draft.includes(next) && draft.length < tagLimits.perMaterial) { setDraft([...draft, next]); setText(""); } }
  async function save() {
    if (!draft || !tag) return;
    const input = materialTagsInput({ tags: draft });
    if (!input) return;
    // `useMutation` يعيد النجاح وحده، فرمز الرد يُقرأ هنا: 412 يعني أن المادة تغيّرت منذ فُتحت.
    const box: { status?: number } = {};
    const ok = await mutation.run(JSON.stringify([material.id, tag, input]), async header => {
      const result = await browserApi().PUT("/materials/{id}/tags", { params: { path: { id: material.id }, header: { ...header, "If-Match": tag } }, body: input });
      box.status = result.response.status; return result;
    });
    setConfirming(false);
    if (ok) { setDraft(null); setNotice("saved"); reload(); }
    else if (box.status === 412) { setDraft(null); setNotice("stale"); mutation.clearStatus(); reload(); }
  }
  if (!editor && !current.length) return null;
  return <section className="material-tags" aria-labelledby="material-tags-title" data-testid="material-tags">
    <h2 id="material-tags-title" className="visually-hidden">{t.title}</h2>
    {!draft ? <>
      {current.length ? <ul className="tag-list large" aria-label={m.shell.inbox.tags}>{current.map(item => <li key={item}><bdi>{item}</bdi></li>)}</ul> : <p className="muted">{t.none}</p>}
      {editor && <button type="button" className="quiet small" data-testid="edit-tags" disabled={!tag} onClick={start}><Icon name="tag" size={14} />{t.edit}</button>}
      {notice === "saved" && <p className="caption" role="status">{t.saved}</p>}
      {notice === "stale" && <p className="notice attention" role="alert" data-testid="tags-stale">{t.stale}</p>}
    </> : <form className="card tag-editor" data-testid="tag-editor" onSubmit={event => { event.preventDefault(); if (changed) { mutation.clearStatus(); setConfirming(true); } }}>
      <h3>{t.title}</h3>
      {draft.length ? <ul className="tag-list large editable">{draft.map(item => <li key={item}><button type="button" className="chip removable" aria-label={fill(t.remove, { tag: item })} onClick={() => setDraft(draft.filter(other => other !== item))}><bdi>{item}</bdi><Icon name="x" size={14} /></button></li>)}</ul> : <p className="muted">{t.none}</p>}
      <div className="tag-add"><label>{t.add}<input value={text} maxLength={tagLimits.tag * 2} dir="auto" aria-invalid={invalid} aria-describedby="tag-add-hint" disabled={full} onChange={event => setText(stripHidden(event.target.value))} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (addable) add(value); } }} /></label>
        <button type="button" className="secondary small" disabled={!addable} onClick={() => add(value)}>{t.addButton}</button></div>
      <small id="tag-add-hint" className={invalid || full ? "field-hint error" : "field-hint"} role="status">{full ? t.max : invalid ? t.invalid : fill(t.counter, { n: codePoints(value) })}</small>
      {suggestions.some(item => !draft.includes(item)) && <div className="tag-suggested"><p className="caption">{t.suggested}</p>
        <ul className="tag-list">{suggestions.filter(item => !draft.includes(item)).slice(0, 12).map(item => <li key={item}><button type="button" className="chip" disabled={full} onClick={() => add(item)}><Icon name="plus" size={12} /><bdi>{item}</bdi></button></li>)}</ul></div>}
      {mutation.status === 403 && <p className="notice error" role="alert">{t.scope}</p>}
      {mutation.status !== 0 && mutation.status !== 200 && mutation.status !== 403 && mutation.status !== 412 && <ActionStatus status={mutation.status} locale={locale} />}
      <div className="actions"><button type="submit" disabled={!changed || mutation.busy}>{t.save}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => { setDraft(null); mutation.clearStatus(); release(); }}>{t.cancel}</button></div>
    </form>}
    {confirming && draft && <ConfirmDialog locale={locale} testId="confirm-tags" title={t.save} confirm={t.save} busy={mutation.busy} status={0} onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
      <p>{fill(t.effect, { n: draft.length })}</p>
    </ConfirmDialog>}
  </section>;
}
