"use client";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { browserApi } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import type { Material, MaterialRender, RenderAspect, RenderTemplate } from "@/lib/types";
import { canSubmit, cleanLine, codePoints, initialDraft, isSensitive, lineOver, locationPreview, renderAspects, renderDetails, renderLabels, renderRequest, renderTemplates, titleLinesMax, type RenderCondition, type RenderDraft } from "@/lib/render-policy";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";
import { BrandMark, Icon } from "./icon";

/** نص المورد بقيمه بين `{}`، وكل قيمة معزولة الاتجاه (`<bdi>`) كما في جدول نصوص web-v2.md. */
export function fill(template: string, values: Record<string, ReactNode>) {
  return template.split(/(\{[a-z]+\})/i).map((part, i) => {
    const key = /^\{([a-z]+)\}$/i.exec(part)?.[1];
    return key && key in values ? <bdi key={i}>{values[key]}</bdi> : <Fragment key={i}>{part}</Fragment>;
  });
}

export type RenderRefusal = { code: "render_not_allowed"; failed: RenderCondition[]; max?: number } | { code: "render_limit_reached" };
type Props = { locale: Locale; material: Material; from?: MaterialRender; onClose: () => void; onCreated: (render: MaterialRender) => void; onRefused: (refusal: RenderRefusal) => void };

/**
 * حوار طلب النسخة (C2–C4، وورقة الهاتف C8–C10): حقول `MaterialRenderRequest` وحدها. القالب أولها («مواد متداولة» أو «الشاهد»،
 * ADR 0110) والمعاينة تتبعه، والوسم إلزامي بلا افتراض، والمكان مطفأ افتراضيًا للمادة الحسّاسة، ونصّه يبنيه الخادم فلا يُرسل؛
 * والمعاينة صورة تجريبية لا إطار من المادة.
 */
export function RenderDialog({ locale, material, from, onClose, onCreated, onRefused }: Props) {
  const m = messages[locale], t = m.derivative.template, d = m.derivative, mutation = useMutation(), dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<RenderDraft>(() => initialDraft(material, from)), [unusable, setUnusable] = useState(false), [handled, setHandled] = useState(false);
  const sensitive = isSensitive(material), location = locationPreview(material), ready = canSubmit(draft) && !(draft.showLocation && unusable);
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  const update = (change: Partial<RenderDraft>) => { setHandled(false); mutation.clearStatus(); setDraft(current => ({ ...current, ...change })); };
  const setLine = (index: number, value: string) => update({ lines: draft.lines.map((line, i) => (i === index ? value : line)) });

  async function submit() {
    const body = renderRequest(draft);
    if (!body || !ready) return;
    let created: MaterialRender | undefined, error: { code?: unknown; details?: unknown } | undefined;
    const ok = await mutation.run(JSON.stringify([material.id, body]), async header => {
      const result = await browserApi().POST("/materials/{id}/renders", { params: { path: { id: material.id }, header }, body });
      created = result.data; error = result.error as typeof error; return result;
    });
    if (ok && created) { onCreated(created); close(); return; }
    if (error?.code === "render_location_unusable") { setHandled(true); setUnusable(true); setDraft(current => ({ ...current, showLocation: false })); return; }
    if (error?.code === "render_not_allowed") { const details = renderDetails(error.details); onRefused({ code: "render_not_allowed", failed: details.failed, max: details.max_source_duration_ms }); close(); return; }
    if (error?.code === "render_limit_reached") { onRefused({ code: "render_limit_reached" }); close(); }
  }

  const locationHint = unusable ? d.blocked.location : draft.showLocation ? fill(t.locationHint, { location }) : sensitive ? t.locationOffSensitive : null;
  return <dialog ref={dialog} className="modal render-dialog" aria-labelledby="render-title" aria-describedby="render-subtitle" onCancel={e => { e.preventDefault(); close(); }}>
    <form noValidate onSubmit={e => { e.preventDefault(); void submit(); }}>
      <header className="render-head">
        <span className="sheet-handle" aria-hidden="true" />
        <div><h2 id="render-title">{t.title}</h2>
          <p id="render-subtitle" className="muted"><span className="wide-only">{fill(t.subtitle, { title: material.title })}</span><span className="narrow-only">{fill(t.subtitleShort, { title: material.title })}</span></p></div>
        <button type="button" className="icon-button sheet-close" aria-label={t.close} onClick={close}><Icon name="x" /></button>
      </header>
      <div className="render-body">
        <div className="render-fields">
          <fieldset className="render-templates" aria-describedby="template-hint"><legend>{t.templateLegend}</legend>
            <p id="template-hint" className="field-hint">{t.templateHint}</p>
            <div className="template-options">{renderTemplates.map(template => <label key={template} className={`template-option${draft.template === template ? " selected" : ""}`}>
              <input className="visually-hidden" type="radio" name="render-template" value={template} checked={draft.template === template} onChange={() => update({ template })} />
              <span className={`template-swatch ${template}`} aria-hidden="true"><i /><i /></span>
              <span className="template-text"><strong>{d.templates[template]}</strong><small>{d.templates[`${template}Caption` as `${RenderTemplate}Caption`]}</small></span></label>)}</div>
          </fieldset>
          <fieldset className="render-lines" aria-describedby={draft.template === "witness" ? "title-hint witness-title-hint" : "title-hint"}><legend>{t.titleLines}</legend>
            <p id="title-hint" className="field-hint">{t.titleHint}</p>
            {draft.template === "witness" && <p id="witness-title-hint" className="field-hint">{t.witnessTitleHint}</p>}
            {draft.lines.map((line, i) => {
              const over = lineOver(line);
              return <div key={i} className={`render-line${over ? " over" : ""}`}>
                <div className="line-box">
                  <span className="line-number" aria-hidden="true">{i + 1}</span>
                  <input dir="rtl" lang="ar" aria-label={t.lineNumber.replace("{n}", String(i + 1))} placeholder={i === titleLinesMax - 1 ? t.line3Placeholder : undefined} value={line} aria-invalid={over}
                    aria-describedby={`line-count-${i}${over ? ` line-error-${i}` : ""}`} onChange={e => setLine(i, cleanLine(e.target.value))} onBlur={e => { if (e.target.value !== e.target.value.trim()) setLine(i, e.target.value.trim()); }} />
                  <span id={`line-count-${i}`} className="line-count" dir="ltr" data-testid="line-count">{t.lineCounter.replace("{count}", String(codePoints(line)))}</span>
                </div>
                {over && <p id={`line-error-${i}`} className="field-error"><Icon name="alert" size={16} /><span>{d.blocked.line}</span></p>}
              </div>;
            })}
            <button type="button" className="link-button" onClick={() => update({ lines: initialDraft(material).lines })}>{t.restoreTitle}</button>
          </fieldset>
          <fieldset className="render-aspects"><legend>{t.ratio}</legend>
            <div className="aspect-options">{renderAspects.map(aspect => <label key={aspect} className={`aspect-option${draft.aspect === aspect ? " selected" : ""}`}>
              <input className="visually-hidden" type="radio" name="render-aspect" value={aspect} checked={draft.aspect === aspect} onChange={() => update({ aspect })} />
              <span className={`aspect-shape ${aspect}`} aria-hidden="true" /><strong>{t.aspect[aspect]}</strong><small>{t.aspect[`${aspect}Caption` as `${RenderAspect}Caption`]}</small></label>)}</div>
            <p className="field-hint">{t.ratioHint}</p>
          </fieldset>
          <div className="render-options">
            <label className={`switch-row${unusable ? " disabled" : ""}`}>
              <span className="switch-text"><strong>{t.showLocation}</strong>{locationHint && <small id="location-hint">{locationHint}</small>}</span>
              <input className="switch" type="checkbox" role="switch" checked={draft.showLocation} disabled={unusable} aria-describedby={locationHint ? "location-hint" : undefined} onChange={e => update({ showLocation: e.target.checked })} />
            </label>
            <fieldset className="render-label" aria-describedby="label-hint"><legend>{t.label}</legend>
              <p id="label-hint" className="field-hint">{t.labelHint}</p>
              <div className="label-options">{renderLabels.map(label => <label key={label} className={`label-option${draft.label === label ? " selected" : ""}`}>
                <input type="radio" name="render-label" value={label} required checked={draft.label === label} onChange={() => update({ label })} />{label === "none" ? t.labelNone : t.labelWith}</label>)}</div>
            </fieldset>
          </div>
          <p className="render-note"><Icon name="alert" size={18} /><span>{t.note}{sensitive && <> {t.noteSensitive}</>}</span></p>
        </div>
        <aside className="render-preview-panel" aria-label={t.preview}>
          <p className="preview-title">{t.preview}</p>
          <RenderPreview template={draft.template} aspect={draft.aspect} lines={draft.lines} tag={draft.label === "circulated_footage" ? t.previewTag : null} location={draft.showLocation && !unusable ? location : null} />
          <p className="preview-caption"><span className="wide-only">{t.previewCaption}</span><span className="narrow-only">{t.previewCaptionPhone}</span></p>
        </aside>
      </div>
      {!handled && mutation.status !== 0 && mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}
      <footer className="render-foot">
        <p className="muted">{draft.label === null && <>{t.chooseLabelFirst} </>}{t.footer}</p>
        <button type="button" className="secondary" disabled={mutation.busy} onClick={close}>{t.cancel}</button>
        <button type="submit" disabled={!ready || mutation.busy}>{t.submit}</button>
      </footer>
    </form>
  </dialog>;
}

/**
 * القالب مصغّرًا بالعنوان والوسم والمكان فوق خلفية تجريبية؛ عربي دائمًا لأن القالب عربي، وزخرفي لأن الحقول تحمل المعنى.
 * «الشاهد»: أربع زوايا حول المشهد، والوسم كبسولة ذهبية أعلى البداية، والعنوان بلا ألواح وسطره الأول فيروزي، ولا شريط حساب.
 */
function RenderPreview({ template, aspect, lines, tag, location }: { template: RenderTemplate; aspect: RenderAspect; lines: string[]; tag: string | null; location: string | null }) {
  const shown = lines.map(line => line.trim()).filter(Boolean), witness = template === "witness";
  return <div className={`render-preview ${aspect} ${template}`} dir="rtl" lang="ar" aria-hidden="true" data-testid="render-preview">
    {witness && <span className="preview-corners"><i /><i /><i /><i /></span>}
    <span className="preview-logo"><BrandMark size={16} /></span>
    {witness && tag && <span className="preview-pill">{tag}</span>}
    <span className="preview-block">
      {!witness && tag && <span className="preview-tag">{tag}</span>}
      {shown.map((line, i) => <span key={i} className="preview-line">{line}</span>)}
      {location && <span className="preview-location">{location}</span>}
    </span>
  </div>;
}
