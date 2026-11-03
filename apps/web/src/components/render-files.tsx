"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { humanDuration, messages, shortTime, type Locale } from "@/lib/i18n";
import type { Material, MaterialRender } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { pollRenders, renderConditions, renderDetails, renderRoles, unfinished, type RenderCondition } from "@/lib/render-policy";
import { useUser } from "./session-boundary";
import { Icon, type IconName } from "./icon";
import { fill, RenderDialog, type RenderRefusal } from "./render-dialog";
import type { StateTone } from "./states";

const stateLook: Record<MaterialRender["state"], { tone: StateTone; icon: IconName }> = {
  requested: { tone: "muted", icon: "clock" }, rendering: { tone: "brand", icon: "film" }, ready: { tone: "ok", icon: "check" }, failed: { tone: "danger", icon: "alert" },
};
/** المنع من 409 يخص المادة كما كانت ساعته؛ أي تغيّر فيها (القبول، التحقق من الأصل، الحقوق) يعيد الزر. */
const materialKey = (m: Material) => [m.version, m.row_version, m.updated_at, m.technical_state, m.editorial_state, m.rights_state].join(":");
const ids = (items: MaterialRender[]) => unfinished(items).map(item => item.id).sort().join(",");

/**
 * بطاقة «الملفات» (C1، C5–C7): الأصل والنسخة الخفيفة من `Material.files`، ونسخ قالب المتداول من `GET /materials/{id}/renders`
 * بحالاتها الأربع، وزرّ الطلب في آخرها. تظهر لأدوار الطلب وحدها، وتختفي كلها حين يردّ الخادم 404 (العلم مطفأ).
 */
export function RenderFiles({ locale, material }: { locale: Locale; material: Material }) {
  const m = messages[locale], d = m.derivative, me = useUser(), allowed = hasRole(me, ...renderRoles);
  const [items, setItems] = useState<MaterialRender[] | null>(null), [status, setStatus] = useState(0), [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<{ from?: MaterialRender } | null>(null), [refusal, setRefusal] = useState<(RenderRefusal & { key: string; ids: string }) | null>(null);
  const [download, setDownload] = useState<{ id: string; busy: boolean; error?: React.ReactNode } | null>(null);
  useEffect(() => {
    if (!allowed) return;
    return pollRenders(signal => browserApi().GET("/materials/{id}/renders", { params: { path: { id: material.id } }, signal }).then(dataOrThrow).then(data => data.items),
      result => { if ("items" in result) { setItems(result.items); setStatus(0); } else setStatus(result.status); }, error => (error instanceof RequestError ? error.status : 503));
  }, [allowed, material.id, attempt]);
  if (!allowed || [401, 403, 404].includes(status) || (items === null && !status)) return null;

  const list = items ?? [], key = materialKey(material);
  const notAllowed = refusal?.code === "render_not_allowed" && refusal.key === key ? refusal : null;
  const limited = unfinished(list).length >= 3 || (refusal?.code === "render_limit_reached" && refusal.ids === ids(list));
  const reasons: { icon: IconName; text: React.ReactNode }[] = notAllowed ? renderConditions.filter(c => notAllowed.failed.includes(c)).map(c => ({ icon: "alert", text: blockedText(c, notAllowed.max) })) : [];
  if (limited) reasons.push({ icon: "clock", text: d.blocked.limit });
  function blockedText(condition: RenderCondition, max?: number): React.ReactNode {
    if (condition === "editorial_state") return fill(d.blocked.editorial_state, { state: m.states.editorial_state[material.editorial_state] ?? material.editorial_state });
    if (condition === "rights_state") return d.blocked.rights_state;
    return <>{d.blocked.source}{max !== undefined && <> {fill(d.blocked.sourceDuration, { max: humanDuration(max, locale) })}</>}</>;
  }
  const original = material.files.some(f => f.kind === "original" && f.state === "verified"), proxy = material.files.some(f => f.kind === "proxy" && f.state === "verified");

  async function fetchLink(item: MaterialRender) {
    if (!item.file_id) return;
    setDownload({ id: item.id, busy: true });
    try {
      // الرابط يُطلب عند النقر ولا يُوضع في الصفحة مسبقًا؛ عمره ≤ 10 دقائق ولا يُخزَّن.
      const result = await browserApi().GET("/materials/{id}/files/{file_id}/download-url", { params: { path: { id: material.id, file_id: item.file_id } } });
      if (result.response.status === 401) window.dispatchEvent(new Event("session-revoked"));
      if (result.data?.url) { setDownload(null); window.location.assign(result.data.url); return; }
      const error = result.error as { code?: unknown; details?: unknown } | undefined;
      const failed = error?.code === "render_not_allowed" ? renderDetails(error.details).failed : [];
      setDownload({ id: item.id, busy: false, error: failed.includes("rights_state") || failed.includes("editorial_state") ? blockedText(failed.includes("rights_state") ? "rights_state" : "editorial_state") : m.error });
    } catch { setDownload({ id: item.id, busy: false, error: m.error }); }
  }

  return <section className="card files-card" aria-labelledby="files-title" data-testid="render-files">
    <h2 id="files-title">{d.files.title}</h2>
    {(original || proxy) && <ul className="file-list">
      {original && <li><Icon name="film" size={16} /><span><strong>{d.files.original}</strong><small>{d.files.originalSub}</small></span></li>}
      {proxy && <li><Icon name="film" size={16} /><span><strong>{d.files.proxy}</strong><small>{d.files.proxySub}</small></span></li>}
    </ul>}
    <div className="render-group">
      <div className="render-group-head"><h3>{d.group.title}</h3><span className="badge state muted"><Icon name="clock" size={14} />{d.group.internalBadge}</span></div>
      <p className="caption">{d.group.inherit}</p>
      {status !== 0 && <div className="notice error" role="alert"><p>{m.error}</p><button type="button" className="secondary small" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></div>}
      {list.length > 0 && <ul className="render-list">{list.map(item => {
        const look = stateLook[item.state], aspect = d.row.aspect[item.aspect], failedHere = download?.id === item.id ? download.error : undefined;
        return <li key={item.id} className={`render-row state-${item.state}`} data-testid="render-row" data-state={item.state}>
          <span className={`aspect-shape ${item.aspect} tone-${look.tone}`} aria-hidden="true" />
          <span className="render-row-text"><strong>{aspect}</strong>
            {item.state === "requested" && <small>{d.row.requestedSub}</small>}
            {item.state === "rendering" && item.started_at && <small>{fill(d.row.renderingSub, { time: <span dir="ltr">{shortTime(item.started_at)}</span> })}</small>}
            {item.state === "ready" && <><small>{fill(d.row.readySub, { time: <span dir="ltr">{shortTime(item.completed_at)}</span> })}</small><small>{d.row.internalUse}</small>{material.rights_state === "unknown" && <small>{d.row.rightsUnknown}</small>}</>}
            {item.state === "failed" && <small className="danger-text">{d.failure[item.failure_reason ?? "render_failed"]}</small>}
            {failedHere && <small className="danger-text" role="alert">{failedHere}</small>}
          </span>
          <span className={`badge state ${look.tone}`}><Icon name={look.icon} size={14} />{d.state[item.state]}</span>
          {item.state === "ready" && item.file_id && <button type="button" className="secondary square-button" aria-label={d.row.downloadAria.replace("{aspect}", aspect)} title={d.row.download} disabled={download?.id === item.id && download.busy} onClick={() => void fetchLink(item)}><Icon name="download" /></button>}
          {item.state === "failed" && <button type="button" className="secondary small" onClick={() => setDialog({ from: item })}>{d.newRequest}</button>}
          {item.state === "rendering" && <span className="render-progress" role="progressbar" aria-label={d.row.renderingAria}><span /></span>}
        </li>;
      })}</ul>}
    </div>
    <div className="render-entry">
      <button type="button" className="secondary render-action" disabled={reasons.length > 0} aria-describedby={reasons.length ? "render-blocked" : undefined} onClick={() => setDialog({})}>{d.template.action}</button>
      {reasons.length > 0 && <ul id="render-blocked" className="render-blocked" data-testid="render-blocked">{reasons.map((reason, i) => <li key={i}><Icon name={reason.icon} size={16} /><span>{reason.text}</span></li>)}</ul>}
    </div>
    {dialog && <RenderDialog locale={locale} material={material} from={dialog.from} onClose={() => setDialog(null)}
      onCreated={render => { setRefusal(null); setItems(current => [render, ...(current ?? []).filter(item => item.id !== render.id)]); setAttempt(n => n + 1); }}
      onRefused={value => { setRefusal({ ...value, key, ids: ids(list) }); setAttempt(n => n + 1); }} />}
  </section>;
}
