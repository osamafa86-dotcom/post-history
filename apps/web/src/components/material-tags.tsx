"use client";
import { useState } from "react";
import { browserApi } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import type { Material } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { fill } from "@/lib/admin-text";
import { materialTagEditors, materialTagsInput } from "@/lib/tag-policy";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { ConfirmDialog } from "./admin-parts";
import { Icon } from "./icon";
import { TagEntry } from "./tag-entry";

/**
 * وسوم المادة في W2 (ADR 0086، 0104، 0105): العرض للجميع كما كان، والتعديل للمشرف في نطاقه ولرئيس التحرير. الحفظ استبدال كامل على
 * `PUT /materials/{id}/tags` بإصدار الصف الحالي (If-Match) ومفتاح منع التكرار، بعد تأكيد يقول أثره. 412: تغيّرت المادة، فيُعاد التحميل
 * ويقول السطر ذلك. المقترحة من قائمة الإدارة ملء أسرع لا قيد. نص الوسم لا يدخل حدثًا ولا تدقيقًا (يحكم فيه الخادم).
 */
export type TagNotice = "saved" | "stale" | "";
/** `notice` يعيش في الصفحة: إعادة التحميل تعيد رسم المادة كلها، والسطر يبقى بعدها. */
export function MaterialTags({ locale, material, tag, notice, setNotice, editing, release, reload }: { locale: Locale; material: Material; tag: string | null; notice: TagNotice; setNotice: (notice: TagNotice) => void; editing: () => void; release: () => void; reload: () => void }) {
  const m = messages[locale], t = m.shell.material.tagEditor, me = useUser(), mutation = useMutation(), editor = hasRole(me, ...materialTagEditors);
  const [draft, setDraft] = useState<string[] | null>(null), [confirming, setConfirming] = useState(false);
  const current = material.tags ?? [];
  const changed = !!draft && (draft.length !== current.length || draft.some((item, i) => item !== current[i]));
  function start() { editing(); mutation.clearStatus(); setNotice(""); setDraft([...current]); }
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
      <TagEntry locale={locale} tags={draft} onChange={setDraft} />
      {mutation.status === 403 && <p className="notice error" role="alert">{t.scope}</p>}
      {mutation.status !== 0 && mutation.status !== 200 && mutation.status !== 403 && mutation.status !== 412 && <ActionStatus status={mutation.status} locale={locale} />}
      <div className="actions"><button type="submit" disabled={!changed || mutation.busy}>{t.save}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => { setDraft(null); mutation.clearStatus(); release(); }}>{t.cancel}</button></div>
    </form>}
    {confirming && draft && <ConfirmDialog locale={locale} testId="confirm-tags" title={t.save} confirm={t.save} busy={mutation.busy} status={0} onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
      <p>{fill(t.effect, { n: draft.length })}</p>
    </ConfirmDialog>}
  </section>;
}
