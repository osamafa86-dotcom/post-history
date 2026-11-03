"use client";
import { useEffect, useRef, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { cleanText, fill, stripHidden } from "@/lib/admin-text";
import { expectedMode, mergeHint, moveTag, tagAdmins, tagLimits, validTag, type TagRewrite, type TagSuggestions, type TagUsage } from "@/lib/tag-policy";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { EmptyState, NoAccess } from "./empty-state";
import { ActionStatus } from "./action-status";
import { ConfirmDialog, LengthCounter, ToneBadge, relativeTime, useDebounced } from "./admin-parts";
import { TableSkeleton } from "./users-admin";
import { Icon } from "./icon";

type Filter = "all" | "suggested" | "reporters";
type Loaded = { value: TagSuggestions; tag: string };
type Notice = { tone: "good" | "error" | "attention"; text: string } | null;

/**
 * الوسوم (A2، ADR 0098): جدول الاستعمال من `GET /tags` (العدد وآخر استعمال وموضع الاقتراح) ببحث ورقاقات، والقائمة المقترحة للمراسلين
 * بترتيبها: الإضافة والحذف والسحب وزرّا التحريك كلٌّ منها طلب `PUT` واحد بالقائمة كاملة و`If-Match`، و412 يعيد تحميل أحدث نسخة ويقول
 * ذلك. والدمج أو إعادة التسمية (`POST /tag-rewrites`) بتأكيد يقول عدد المواد التي سيُستبدل فيها الوسم؛ الخادم يحسم الوضع.
 * «قبول الوسوم الجديدة من المراسلين» لا يُرسم (ADR 0098، 0099).
 */
export function TagsAdmin({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.tags, me = useUser(), allowed = hasRole(me, ...tagAdmins), mutation = useMutation();
  const [filter, setFilter] = useState<Filter>("all"), [search, setSearch] = useState(""), q = useDebounced(cleanText(search), 300);
  const [rows, setRows] = useState<TagUsage[] | null>(null), [cursor, setCursor] = useState<string | null>(null), [failed, setFailed] = useState(false), [more, setMore] = useState(false), [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<Loaded | null>(null), [listFailed, setListFailed] = useState(false), [listAttempt, setListAttempt] = useState(0);
  const [rewrite, setRewrite] = useState<{ source: TagUsage; target: string } | null>(null), [notice, setNotice] = useState<Notice>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const query = { limit: tagLimits.page, ...(q && Array.from(q).length <= tagLimits.tag ? { q } : {}), ...(filter === "all" ? {} : { suggested: filter === "suggested" }) }, key = JSON.stringify(query);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/tags", { params: { query: JSON.parse(key) }, signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) { setRows(data.items); setCursor(data.next_cursor); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [allowed, key, attempt]);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/tag-suggestions", { signal: controller.signal }).then(result => { const value = dataOrThrow(result); if (!controller.signal.aborted) { setList({ value, tag: result.response.headers.get("ETag") ?? `"${value.version}"` }); setListFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setListFailed(true); });
    return () => controller.abort();
  }, [allowed, listAttempt]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;

  async function loadMore() {
    if (!cursor) return; setMore(true);
    try { const data = dataOrThrow(await browserApi().GET("/tags", { params: { query: { ...JSON.parse(key), cursor } } })); setRows(old => [...(old ?? []), ...data.items]); setCursor(data.next_cursor); }
    catch { setFailed(true); } finally { setMore(false); }
  }
  /** طلب واحد بالقائمة كاملة؛ 412 يعيد تحميل أحدث نسخة ويقول ذلك، فلا يُكتب فوق تغيير من جلسة أخرى. */
  async function replace(tags: string[], success: string) {
    if (!list) return false;
    const tag = list.tag, box: { saved?: Loaded; status?: number } = {};
    setNotice(null);
    const ok = await mutation.run(JSON.stringify([tag, tags]), async header => {
      const result = await browserApi().PUT("/tag-suggestions", { params: { header: { ...header, "If-Match": tag } }, body: { tags } });
      box.status = result.response.status;
      if (result.data) box.saved = { value: result.data, tag: result.response.headers.get("ETag") ?? `"${result.data.version}"` };
      return result;
    });
    const saved = box.saved;
    if (ok && saved) { setList(saved); setNotice({ tone: "good", text: fill(success, { version: saved.value.version }) }); setAttempt(n => n + 1); return true; }
    // 412: تغيّرت القائمة في جلسة أخرى؛ تُحمَّل أحدث نسخة ويُقال ذلك، فلا يُكتب فوق ما لم يُقرأ.
    if (box.status === 412) { setNotice({ tone: "attention", text: t.listChanged }); mutation.clearStatus(); setListAttempt(n => n + 1); setAttempt(n => n + 1); }
    return false;
  }
  const status = mutation.status;
  const suggested = list?.value.tags ?? [];
  const known = new Set([...(rows ?? []).map(row => row.tag), ...suggested]);
  function suggest(tag: string) {
    if (suggested.includes(tag)) return;
    if (suggested.length >= tagLimits.suggestions) { setNotice({ tone: "error", text: fill(t.full, { max: tagLimits.suggestions }) }); return; }
    void replace([...suggested, tag], fill(t.added, { tag }));
  }
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{fill(t.lead, { perMaterial: tagLimits.perMaterial, max: tagLimits.tag })}</p></div>
      <div className="page-actions"><button type="button" onClick={() => { addRef.current?.scrollIntoView({ block: "center" }); addRef.current?.focus(); }}>{t.newTag}</button></div></div>
    {notice && <p className={`notice ${notice.tone}`} role={notice.tone === "good" ? "status" : "alert"} data-testid="tags-notice">{notice.text}</p>}
    {status !== 200 && status !== 412 && status !== 0 && !rewrite && <ActionStatus status={status} locale={locale} />}
    <div className="tags-layout">
      <section className="card table-card" aria-labelledby="tag-usage-title">
        <h2 id="tag-usage-title" className="visually-hidden">{t.usageTitle}</h2>
        <div className="admin-toolbar">
          <form role="search" className="admin-search" onSubmit={event => event.preventDefault()}>
            <label htmlFor="tag-search" className="visually-hidden">{t.searchLabel}</label>
            <span className="search-icon"><Icon name="search" /></span>
            <input id="tag-search" type="search" value={search} maxLength={tagLimits.tag} placeholder={t.searchLabel} autoComplete="off" onChange={event => setSearch(stripHidden(event.target.value))} />
          </form>
          <nav className="quick-tabs" aria-label={t.filtersLabel}>{(["all", "suggested", "reporters"] as Filter[]).map(value => <button key={value} type="button" className={filter === value ? "chip active" : "chip"} aria-pressed={filter === value} onClick={() => { if (value !== filter) { setFilter(value); setRows(null); } }}>{t.filters[value]}</button>)}</nav>
        </div>
        {failed && <p className="notice error" role="alert">{rows ? m.stale : m.error} <button type="button" className="link-button" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
        {!rows ? (failed ? null : <TableSkeleton columns={5} label={m.loading} />)
          : !rows.length ? <EmptyState icon="search" testId="tags-empty" title={q || filter !== "all" ? t.emptyFiltered : t.empty} actions={q || filter !== "all" ? <button type="button" className="secondary" onClick={() => { setSearch(""); setFilter("all"); }}>{t.clear}</button> : undefined}><p>{t.emptyBody}</p></EmptyState>
          : <><table className="admin-table tags-table">
            <thead><tr><th scope="col">{t.columns.tag}</th><th scope="col">{t.columns.materials}</th><th scope="col">{t.columns.source}</th><th scope="col">{t.columns.lastUsed}</th><th scope="col"><span className="visually-hidden">{t.columns.actions}</span></th></tr></thead>
            <tbody>{rows.map(row => {
              const hint = row.suggested_position === null ? mergeHint(row.tag, suggested) : null;
              return <tr key={row.tag} data-testid="tag-row">
                <td className="cell-primary"><span className="tag-name"><Icon name="tag" size={16} /><bdi>{row.tag}</bdi></span></td>
                <td data-label={t.columns.materials}><span className="num" dir="ltr">{row.material_count}</span></td>
                <td data-label={t.columns.source}>{row.suggested_position !== null ? <ToneBadge tone="brand" icon="check">{fill(t.sourceSuggested, { n: row.suggested_position })}</ToneBadge> : <ToneBadge tone="muted" icon="clock">{t.sourceReporters}</ToneBadge>}</td>
                <td data-label={t.columns.lastUsed}><span className="muted">{relativeTime(row.last_used_at, locale) ?? t.neverUsed}</span></td>
                <td className="cell-actions"><div className="row-buttons">
                  {row.suggested_position === null && <button type="button" className="quiet small" disabled={mutation.busy || !list} aria-label={fill(t.suggestLabel, { tag: row.tag })} onClick={() => suggest(row.tag)}>{t.suggest}</button>}
                  <button type="button" className="quiet small" disabled={mutation.busy} aria-label={hint ? fill(t.mergeIntoLabel, { tag: row.tag, target: hint }) : fill(t.rewriteLabel, { tag: row.tag })} onClick={() => { mutation.clearStatus(); setNotice(null); setRewrite({ source: row, target: hint ?? "" }); }}>{hint ? fill(t.mergeInto, { tag: hint }) : t.rewrite}</button>
                </div></td>
              </tr>;
            })}</tbody>
          </table>
          {cursor && <div className="pagination"><button type="button" className="secondary" disabled={more} onClick={() => void loadMore()}>{t.loadMore}</button></div>}</>}
        <p className="caption table-foot">{t.mergeNote}</p>
      </section>
      <SuggestionsPanel locale={locale} list={list?.value ?? null} failed={listFailed} busy={mutation.busy} addRef={addRef} onRetry={() => setListAttempt(n => n + 1)} onReplace={replace} onInvalid={text => setNotice({ tone: "error", text })} />
    </div>
    {rewrite && <RewriteDialog locale={locale} source={rewrite.source} initial={rewrite.target} known={known} suggested={suggested} onClose={() => setRewrite(null)}
      onDone={result => { setRewrite(null); setNotice({ tone: "good", text: fill(result.mode === "merge" ? t.doneMerge : t.doneRename, { source: result.source, target: result.target, count: plural(result.materials_updated, t.materials as PluralForms, locale) }) }); setAttempt(n => n + 1); setListAttempt(n => n + 1); }}
      onMissing={() => { setRewrite(null); setNotice({ tone: "attention", text: fill(t.notFound, { source: rewrite.source.tag }) }); setAttempt(n => n + 1); setListAttempt(n => n + 1); }} />}
  </>;
}

/** «مقترحة للمراسلين» (A2): بترتيب ظهورها، تُسحب أو تُحرَّك بزرّين، وتُزال بـ ×، ويُضاف إليها من الحقل. */
function SuggestionsPanel({ locale, list, failed, busy, addRef, onRetry, onReplace, onInvalid }: { locale: Locale; list: TagSuggestions | null; failed: boolean; busy: boolean; addRef: React.RefObject<HTMLInputElement | null>; onRetry: () => void; onReplace: (tags: string[], success: string) => Promise<boolean>; onInvalid: (text: string) => void }) {
  const m = messages[locale], t = m.tags, [draft, setDraft] = useState(""), [dragging, setDragging] = useState<number | null>(null), [over, setOver] = useState<number | null>(null);
  const tags = list?.tags ?? [], value = cleanText(draft), full = tags.length >= tagLimits.suggestions, duplicate = !!value && tags.includes(value);
  async function add() {
    if (!validTag(value)) { onInvalid(fill(t.addInvalid, { max: tagLimits.tag })); return; }
    if (duplicate) { onInvalid(t.duplicate); return; }
    if (full) { onInvalid(fill(t.full, { max: tagLimits.suggestions })); return; }
    if (await onReplace([...tags, value], fill(t.added, { tag: value }))) setDraft("");
  }
  const move = (from: number, to: number, tag: string) => void onReplace(moveTag(tags, from, to), fill(t.moved, { tag, n: to + 1 }));
  return <section className="card suggestions-card" aria-labelledby="suggestions-title" data-testid="suggestions">
    <h2 id="suggestions-title">{t.panelTitle}</h2><p className="muted">{t.panelLead}</p>
    {!list ? (failed ? <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" onClick={onRetry}>{m.retry}</button></p> : <p role="status" className="muted">{m.loading}</p>)
      : <>
        <p className="caption" dir="auto">{fill(t.count, { count: tags.length, max: tagLimits.suggestions })} · {fill(t.version, { version: list.version })}</p>
        {!tags.length ? <p className="empty">{t.emptyList}</p> : <ol className="suggestion-list" aria-describedby="suggestions-hint">{tags.map((tag, index) => <li key={tag} data-testid="suggestion" className={`${dragging === index ? "dragging" : ""}${over === index && dragging !== index ? " drop-target" : ""}`}
          draggable={!busy} onDragStart={event => { setDragging(index); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }}
          onDragOver={event => { if (dragging !== null) { event.preventDefault(); setOver(index); } }} onDragLeave={() => setOver(o => o === index ? null : o)}
          onDrop={event => { event.preventDefault(); const from = dragging; setDragging(null); setOver(null); if (from !== null && from !== index) move(from, index, tags[from]); }} onDragEnd={() => { setDragging(null); setOver(null); }}>
          <span className="drag-handle" aria-hidden="true"><Icon name="grip" size={16} /></span>
          <span className="position" dir="ltr" aria-hidden="true">{index + 1}</span>
          <bdi className="suggestion-text">{tag}</bdi>
          <span className="suggestion-buttons">
            <button type="button" className="icon-button small-icon" disabled={busy || index === 0} aria-label={fill(t.moveUp, { tag })} onClick={() => move(index, index - 1, tag)}><Icon name="chevron" size={16} /></button>
            <button type="button" className="icon-button small-icon down" disabled={busy || index === tags.length - 1} aria-label={fill(t.moveDown, { tag })} onClick={() => move(index, index + 1, tag)}><Icon name="chevron" size={16} /></button>
            <button type="button" className="icon-button small-icon" disabled={busy} aria-label={fill(t.remove, { tag })} onClick={() => void onReplace(tags.filter(item => item !== tag), fill(t.removed, { tag }))}><Icon name="x" size={16} /></button>
          </span>
        </li>)}</ol>}
        <p id="suggestions-hint" className="visually-hidden">{t.dragHint}</p>
        <form className="suggestion-add" noValidate onSubmit={event => { event.preventDefault(); void add(); }}>
          <label htmlFor="suggestion-input">{t.addLabel}</label>
          <div className="add-row"><input id="suggestion-input" ref={addRef} value={draft} maxLength={tagLimits.tag * 2} autoComplete="off" disabled={busy} aria-invalid={!!draft && (!validTag(value) || duplicate) ? true : undefined} aria-describedby="suggestion-counter suggestion-help" onChange={event => setDraft(stripHidden(event.target.value))} />
            <button type="submit" className="secondary" disabled={busy || !value || full}>{t.add}</button></div>
          <div className="field-foot"><small id="suggestion-help" className="caption">{full ? fill(t.full, { max: tagLimits.suggestions }) : duplicate ? t.duplicate : t.addHelp}</small><LengthCounter id="suggestion-counter" value={value} max={tagLimits.tag} /></div>
        </form>
      </>}
  </section>;
}

/** الدمج أو إعادة التسمية بتأكيد يقول الأثر: عدد المواد، وما يحدث للقائمة المقترحة، وأن الأصل يُحفظ في السجل. */
function RewriteDialog({ locale, source, initial, known, suggested, onClose, onDone, onMissing }: { locale: Locale; source: TagUsage; initial: string; known: Set<string>; suggested: readonly string[]; onClose: () => void; onDone: (result: TagRewrite) => void; onMissing: () => void }) {
  const m = messages[locale], t = m.tags, mutation = useMutation(), [draft, setDraft] = useState(initial);
  const target = cleanText(draft), valid = validTag(target) && target !== source.tag, mode = valid ? expectedMode(target, known) : null;
  const count = plural(source.material_count, t.materials as PluralForms, locale);
  async function apply() {
    if (!valid) return;
    const box: { result?: TagRewrite; status?: number } = {};
    const ok = await mutation.run(JSON.stringify([source.tag, target]), async header => { const reply = await browserApi().POST("/tag-rewrites", { params: { header }, body: { source: source.tag, target } }); box.result = reply.data; box.status = reply.response.status; return reply; });
    if (ok && box.result) onDone(box.result);
    else if (box.status === 404) onMissing();
  }
  const listLine = !valid || !suggested.includes(source.tag) ? null : suggested.includes(target) ? t.effectSuggestedDrop : t.effectSuggested;
  return <ConfirmDialog locale={locale} testId="rewrite-dialog" title={fill(t.dialogTitle, { tag: source.tag })} confirm={mode === "rename" ? t.confirmRename : t.confirmMerge} busy={mutation.busy} confirmDisabled={!valid} status={mutation.status} danger onConfirm={() => void apply()} onCancel={onClose}>
    <label htmlFor="rewrite-target">{t.target}</label>
    <input id="rewrite-target" list="rewrite-known" value={draft} maxLength={tagLimits.tag * 2} autoComplete="off" disabled={mutation.busy} aria-describedby="rewrite-help rewrite-effect" aria-invalid={!!draft && !valid ? true : undefined} onChange={event => { setDraft(stripHidden(event.target.value)); mutation.clearStatus(); }} />
    <datalist id="rewrite-known">{[...known].filter(tag => tag !== source.tag).slice(0, 100).map(tag => <option key={tag} value={tag} />)}</datalist>
    <div className="field-foot"><small id="rewrite-help" className="caption">{target === source.tag ? t.sameTag : t.targetHelp}</small><LengthCounter value={target} max={tagLimits.tag} /></div>
    <div id="rewrite-effect" className="effect" aria-live="polite">{valid && mode && <>
      <p data-testid="rewrite-effect"><strong>{mode === "merge" ? t.modeMerge : t.modeRename}</strong> {fill(mode === "merge" ? t.effectMerge : t.effectRename, { source: source.tag, target, count })}</p>
      {listLine && <p>{fill(listLine, { source: source.tag, target })}</p>}
      <p className="muted">{t.effectLog}</p><p className="muted">{t.serverDecides}</p>
    </>}</div>
  </ConfirmDialog>;
}

