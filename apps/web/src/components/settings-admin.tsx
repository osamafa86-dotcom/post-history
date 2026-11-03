"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { cleanText, fill, stripHidden, validText } from "@/lib/admin-text";
import { platformAdmins, platformFields, platformLimits, type PlatformSettings, type PlatformSettingsUpdate } from "@/lib/platform-policy";
import { inputOf, type Rule } from "@/lib/notification-policy";
import { permissionLabel } from "@/lib/admin-labels";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { NoAccess } from "./empty-state";
import { ActionStatus } from "./action-status";
import { LengthCounter } from "./admin-parts";
import { IdentitySetting } from "./identity-setting";
import { Icon } from "./icon";

type Notice = { tone: "good" | "attention"; text: string } | null;

/**
 * الإعدادات والتنبيهات (A6، ADR 0099): هوية المنصة (`GET`/`PUT /platform-settings` بـ `If-Match`، و412 يعيد تحميل أحدث نسخة ويقول
 * ذلك)، وقاعدتان ثابتتان في المنصة تُقالان ولا تُرسمان مفتاحين، وسياسة هوية المراسل، وقواعد التنبيه بمفتاح التفعيل لكلٍّ منها.
 * «قبول الوسوم الجديدة من المراسلين» لا يُرسم (ADR 0099).
 */
export function SettingsAdmin({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.settings, me = useUser(), allowed = hasRole(me, ...platformAdmins), mutation = useMutation();
  const [loaded, setLoaded] = useState<{ value: PlatformSettings; tag: string } | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<PlatformSettingsUpdate | null>(null), [notice, setNotice] = useState<Notice>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/platform-settings", { signal: controller.signal }).then(result => {
      const value = dataOrThrow(result);
      if (!controller.signal.aborted) { setLoaded({ value, tag: result.response.headers.get("ETag") ?? `"${value.version}"` }); setDraft({ platform_name: value.platform_name, app_name: value.app_name, watermark_text: value.watermark_text }); setFailed(false); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [allowed, attempt]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;
  const cleaned = draft ? Object.fromEntries(platformFields.map(field => [field, cleanText(draft[field])])) as PlatformSettingsUpdate : null;
  const invalid = cleaned ? platformFields.filter(field => !validText(cleaned[field], platformLimits[field])) : [];
  const changed = !!(cleaned && loaded && platformFields.some(field => cleaned[field] !== loaded.value[field]));
  async function save() {
    if (!cleaned || !loaded || invalid.length || !changed) return;
    const tag = loaded.tag, body = cleaned, box: { saved?: { value: PlatformSettings; tag: string }; status?: number } = {};
    setNotice(null);
    const ok = await mutation.run(JSON.stringify([tag, body]), async header => {
      const result = await browserApi().PUT("/platform-settings", { params: { header: { ...header, "If-Match": tag } }, body });
      box.status = result.response.status;
      if (result.data) box.saved = { value: result.data, tag: result.response.headers.get("ETag") ?? `"${result.data.version}"` };
      return result;
    });
    if (ok && box.saved) { setLoaded(box.saved); setDraft(body); setNotice({ tone: "good", text: fill(t.saved, { version: box.saved.value.version }) }); }
    // 412: أحدث نسخة تُحمَّل وتُقال، والمدخلات غير المحفوظة تُستبدل بها كي لا يُحفظ فوق تغيير لم يُقرأ.
    else if (box.status === 412) { setNotice({ tone: "attention", text: t.changed }); mutation.clearStatus(); setAttempt(n => n + 1); }
  }
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div>
      <div className="page-actions"><button type="submit" form="platform-form" disabled={!loaded || mutation.busy || !changed || invalid.length > 0}>{mutation.busy ? m.review.saving : t.save}</button></div></div>
    {notice && <p className={`notice ${notice.tone}`} role={notice.tone === "good" ? "status" : "alert"} data-testid="settings-notice">{notice.text}</p>}
    {mutation.status !== 0 && mutation.status !== 200 && mutation.status !== 412 && <ActionStatus status={mutation.status} locale={locale} />}
    <div className="settings-layout">
      <div className="settings-side">
        <section className="card" aria-labelledby="platform-title">
          <h2 id="platform-title">{t.identityTitle}</h2>
          {!loaded || !draft ? (failed ? <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>{m.retry}</button></p> : <p role="status" className="muted">{m.loading}</p>)
            : <form id="platform-form" className="platform-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
              {platformFields.map(field => {
                const value = cleaned![field], bad = invalid.includes(field);
                return <div key={field} className="field">
                  <label htmlFor={`platform-${field}`}>{t.fields[field]}</label>
                  <input id={`platform-${field}`} value={draft[field]} maxLength={platformLimits[field] * 2} disabled={mutation.busy} autoComplete="off" aria-invalid={bad ? true : undefined} aria-describedby={`platform-${field}-help`} onChange={event => { setNotice(null); setDraft({ ...draft, [field]: stripHidden(event.target.value) }); }} />
                  <div className="field-foot"><small id={`platform-${field}-help`} className={bad ? "caption danger-text" : "caption"}>{bad ? fill(t.invalidField, { max: platformLimits[field] }) : t.help[field]}</small><LengthCounter value={value} max={platformLimits[field]} /></div>
                </div>;
              })}
              <p className="caption">{fill(t.version, { version: loaded.value.version, date: formatDate(loaded.value.updated_at, locale) })}</p>
              <p className="notice attention">{t.notConsumed}</p>
            </form>}
        </section>
        <section className="card" aria-labelledby="fixed-title">
          <h2 id="fixed-title">{t.fixedTitle}</h2><p className="muted">{t.fixedLead}</p>
          <ul className="fixed-rules">{(["hideName", "stripLocation"] as const).map(rule => <li key={rule}><span className="fixed-icon"><Icon name="shield" size={16} /></span><span className="fixed-text"><strong>{t.fixed[rule]}</strong><small>{t.fixed[`${rule}Why`]}</small></span><span className="badge state ok"><Icon name="check" size={14} />{t.always}</span></li>)}</ul>
        </section>
      </div>
      <div className="settings-main">
        <RulesSummary locale={locale} />
        <IdentitySetting locale={locale} onChanged={() => {}} />
      </div>
    </div>
  </>;
}

/** قواعد التنبيه (A6): عندما، ومن يُنبَّه، والقناة، ومفتاح التفعيل؛ والمحرّر الكامل في صفحة القواعد. */
function RulesSummary({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.settings, r = m.rules, me = useUser(), writer = hasRole(me, "system_admin"), mutation = useMutation();
  const [items, setItems] = useState<Rule[] | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [notice, setNotice] = useState<Notice>(null), [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/notification-rules", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setFailed(false); } }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  async function toggle(rule: Rule) {
    const body = { ...inputOf(rule), enabled: !rule.enabled }, tag = `"${rule.row_version}"`, box: { status?: number } = {};
    setPending(rule.id); setNotice(null);
    const ok = await mutation.run(JSON.stringify([rule.id, tag, body.enabled]), async header => { const result = await browserApi().PUT("/notification-rules/{rule_id}", { params: { path: { rule_id: rule.id }, header: { ...header, "If-Match": tag } }, body }); box.status = result.response.status; return result; });
    setPending(null);
    if (ok) { setNotice({ tone: "good", text: fill(body.enabled ? t.ruleOn : t.ruleOff, { name: rule.name }) }); setAttempt(n => n + 1); }
    else if (box.status === 412) { setNotice({ tone: "attention", text: t.ruleChanged }); mutation.clearStatus(); setAttempt(n => n + 1); }
  }
  const roleNames = r.roleNames as Record<string, string>, events = r.events as Record<string, string>, channels = r.channelNames as Record<string, string>;
  return <section className="card table-card" aria-labelledby="rules-title">
    <div className="card-head"><h2 id="rules-title">{t.rulesTitle}</h2><Link prefetch={false} className="button quiet small" href={`/${locale}/notification-rules`}>{writer ? t.addRule : t.allRules}</Link></div>
    {notice && <p className={`notice ${notice.tone}`} role={notice.tone === "good" ? "status" : "alert"}>{notice.text}</p>}
    {mutation.status !== 0 && mutation.status !== 200 && mutation.status !== 412 && <ActionStatus status={mutation.status} locale={locale} />}
    {failed ? <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>
      : !items ? <p role="status" className="muted">{m.loading}</p>
      : !items.length ? <p className="empty">{t.noRules}</p>
      : <table className="admin-table rules-table">
        <thead><tr><th scope="col">{t.columns.when}</th><th scope="col">{t.columns.who}</th><th scope="col">{t.columns.channel}</th><th scope="col">{t.columns.enabled}</th></tr></thead>
        <tbody>{items.map(rule => {
          const who = [...(rule.recipient_roles ?? []).map(role => roleNames[role] ?? r.otherRole), ...(rule.recipient_permissions ?? []).map(permission => permissionLabel(permission, locale))].join(" + ");
          const urgent = rule.event_type === "material.urgent_received";
          return <tr key={rule.id} data-testid="rule-summary">
            <td className="cell-primary"><span className="rule-when"><Icon name={urgent ? "bolt" : "bell"} size={16} /><span><strong>{events[rule.event_type] ?? rule.event_type}</strong><small className="muted"><bdi>{rule.name}</bdi>{rule.quiet_hours && <> · {fill(t.quiet, { start: rule.quiet_hours.start, end: rule.quiet_hours.end })}</>}</small></span></span></td>
            <td data-label={t.columns.who}>{who || "—"}</td>
            <td data-label={t.columns.channel}>{rule.channels.map(channel => channels[channel] ?? channel).join(" + ")}</td>
            <td data-label={t.columns.enabled}><label className="switch-cell"><input type="checkbox" role="switch" className="switch" checked={rule.enabled ?? true} disabled={!writer || mutation.busy} aria-label={fill(t.toggle, { name: rule.name })} onChange={() => void toggle(rule)} /><span className="switch-word">{pending === rule.id ? m.review.saving : rule.enabled ?? true ? r.enabled : r.disabled}</span></label></td>
          </tr>;
        })}</tbody>
      </table>}
    <p className="caption table-foot"><Icon name="bell" size={14} /> {t.quietNote}</p>
  </section>;
}
