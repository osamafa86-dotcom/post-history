"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { materialTypes, states } from "@/lib/query";
import { permissions } from "@/lib/admin-policy";
import { permissionLabel } from "@/lib/admin-labels";
import { useMutation } from "@/lib/use-mutation";
import { channels, emptyRule, inputOf, roleLabel, roles, ruleEvents, ruleInput, scopeKinds, type Rule, type RuleInput } from "@/lib/notification-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";

type Draft = { id: string | null; tag: string | null; rule: RuleInput };
const toggle = <T,>(list: T[], value: T) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];

export function NotificationRules({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.rules, me = useUser(), admin = hasRole(me, "system_admin"), mutation = useMutation();
  const [rules, setRules] = useState<Rule[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null), [invalid, setInvalid] = useState(false), [removing, setRemoving] = useState<Rule | null>(null);
  const allowed = hasRole(me, "system_admin", "editor_in_chief");
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/notification-rules", { signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setRules(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt, allowed]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  async function open(rule: Rule) {
    // القراءة المفردة تعطي ETag الحالي؛ الاستبدال يرسله في If-Match.
    mutation.clearStatus(); setInvalid(false);
    try {
      const result = await browserApi().GET("/notification-rules/{rule_id}", { params: { path: { rule_id: rule.id } } });
      const data = dataOrThrow(result);
      setDraft({ id: data.id, tag: result.response.headers.get("ETag"), rule: inputOf(data) });
    } catch { setError(true); }
  }
  async function save() {
    if (!draft) return;
    const input = ruleInput(draft.rule as unknown as Record<string, unknown>);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    const current = draft;
    const ok = await mutation.run(JSON.stringify(current), header => current.id
      ? browserApi().PUT("/notification-rules/{rule_id}", { params: { path: { rule_id: current.id }, header: { ...header, "If-Match": current.tag ?? "" } }, body: input })
      : browserApi().POST("/notification-rules", { params: { header }, body: input }));
    if (ok) { setDraft(null); setAttempt(n => n + 1); }
  }
  async function remove(rule: Rule) {
    const ok = await mutation.run(`delete:${rule.id}:${rule.row_version}`, header => browserApi().DELETE("/notification-rules/{rule_id}", { params: { path: { rule_id: rule.id }, header: { ...header, "If-Match": `"${rule.row_version}"` } } }));
    if (ok) { setRemoving(null); setAttempt(n => n + 1); }
  }
  const set = <K extends keyof RuleInput>(key: K, value: RuleInput[K]) => setDraft(current => current && { ...current, rule: { ...current.rule, [key]: value } });

  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p>{!admin && <p className="notice">{t.readOnly}</p>}</div>{admin && !draft && <button onClick={() => { mutation.clearStatus(); setInvalid(false); setDraft({ id: null, tag: null, rule: emptyRule() }); }}>{t.new}</button>}</div>
    {!draft && <ActionStatus status={mutation.status} locale={locale} />}
    {draft ? <RuleForm locale={locale} rule={draft.rule} set={set} busy={mutation.busy} onSave={() => void save()} onCancel={() => setDraft(null)} invalid={invalid} status={mutation.status} />
      : error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
      : !rules ? <p className="center-state" role="status">{m.loading}</p>
      : !rules.length ? <p className="empty">{t.empty}</p>
      : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[t.name, t.event, t.channels, t.levels, t.enabled, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rules.map(rule => <tr key={rule.id} data-testid="rule-row"><td>{rule.name}</td><td>{t.events[rule.event_type]}</td><td>{rule.channels.map(c => t.channelNames[c]).join(" · ")}</td><td>{rule.escalation?.length ?? 0}</td><td><span className={`badge ${rule.enabled ? "good" : ""}`}>{rule.enabled ? t.enabled : t.disabled}</span></td>
          <td>{admin && <div className="actions"><button className="secondary" onClick={() => void open(rule)}>{t.edit}</button><button className="quiet" onClick={() => { mutation.clearStatus(); setRemoving(rule); }}>{t.delete}</button></div>}</td></tr>)}</tbody></table></div></div>}
    {removing && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} aria-labelledby="delete-rule-title" onCancel={event => { if (mutation.busy) event.preventDefault(); else setRemoving(null); }}><h2 id="delete-rule-title">{t.delete}</h2><p>{t.confirmDelete}</p><p><strong>{removing.name}</strong></p>
      <ActionStatus status={mutation.status} locale={locale} /><div className="actions"><button autoFocus className="secondary" disabled={mutation.busy} onClick={() => setRemoving(null)}>{t.cancel}</button><button className="danger" disabled={mutation.busy} onClick={() => void remove(removing)}>{t.delete}</button></div></dialog>}
  </>;
}

function Checks<T extends string>({ legend, values, selected, label, change, name }: { legend: string; values: readonly T[]; selected: T[]; label: (value: T) => string; change: (next: T[]) => void; name: string }) {
  return <fieldset className="check-group"><legend>{legend}</legend>{values.map(value => <label key={value} className="check"><input type="checkbox" name={name} value={value} checked={selected.includes(value)} onChange={() => change(toggle(selected, value))} />{label(value)}</label>)}</fieldset>;
}

function RuleForm({ locale, rule, set, busy, onSave, onCancel, invalid, status }: { locale: Locale; rule: RuleInput; set: <K extends keyof RuleInput>(key: K, value: RuleInput[K]) => void; busy: boolean; onSave: () => void; onCancel: () => void; invalid: boolean; status: number }) {
  const m = messages[locale], t = m.rules, steps = rule.escalation ?? [];
  const number = (value: string) => value === "" ? null : Number(value);
  return <form className="card form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); onSave(); }}>
    <label>{t.name}<input value={rule.name} maxLength={120} onChange={e => set("name", e.target.value)} /><small className="muted">{t.nameHelp}</small></label>
    <label>{t.event}<select value={rule.event_type} onChange={e => set("event_type", e.target.value as RuleInput["event_type"])}>{ruleEvents.map(event => <option key={event} value={event}>{t.events[event]}</option>)}</select></label>
    <Checks legend={t.priorities} name="priorities" values={states.priority} selected={rule.priorities ?? []} label={p => m.states.priority[p]} change={next => set("priorities", next.length ? next : null)} />
    <Checks legend={t.types} name="types" values={materialTypes} selected={rule.material_types ?? []} label={type => m.types[type]} change={next => set("material_types", next.length ? next : null)} />
    <div className="rule-row"><label>{t.scope}<select value={rule.scope_kind} onChange={e => { set("scope_kind", e.target.value as RuleInput["scope_kind"]); if (e.target.value === "all") set("scope_id", ""); }}>{scopeKinds.map(kind => <option key={kind} value={kind}>{t.scopes[kind]}</option>)}</select></label>
      {rule.scope_kind !== "all" && <label>{t.scopeId}<input value={rule.scope_id ?? ""} maxLength={200} onChange={e => set("scope_id", e.target.value)} /></label>}</div>
    <Checks legend={t.roles} name="roles" values={roles} selected={rule.recipient_roles ?? []} label={role => roleLabel(t.roleNames, role, t.otherRole)} change={next => set("recipient_roles", next)} />
    <Checks legend={t.permissions} name="permissions" values={permissions} selected={rule.recipient_permissions ?? []} label={p => permissionLabel(p, locale)} change={next => set("recipient_permissions", next)} />
    <Checks legend={t.channels} name="channels" values={channels} selected={rule.channels} label={c => t.channelNames[c]} change={next => set("channels", next)} />
    <div className="rule-row"><label>{t.delay}<input type="number" min={0} max={86400} value={rule.delay_seconds ?? 0} onChange={e => set("delay_seconds", Number(e.target.value) || 0)} /></label>
      <label>{t.digest}<input type="number" min={15} max={1440} value={rule.digest_interval_minutes ?? ""} onChange={e => set("digest_interval_minutes", number(e.target.value))} /></label></div>
    <fieldset className="check-group"><legend>{t.quiet}</legend><small className="muted">{t.quietHelp}</small>
      <label className="check"><input type="checkbox" checked={!!rule.quiet_hours} onChange={e => set("quiet_hours", e.target.checked ? { start: "22:00", end: "07:00", timezone: "Asia/Gaza" } : null)} />{t.enabled}</label>
      {rule.quiet_hours && <div className="rule-row">{(["start", "end"] as const).map(key => <label key={key}>{key === "start" ? t.quietStart : t.quietEnd}<input type="time" value={rule.quiet_hours![key]} onChange={e => set("quiet_hours", { ...rule.quiet_hours!, [key]: e.target.value })} /></label>)}
        <label>{t.timezone}<input dir="ltr" value={rule.quiet_hours.timezone} maxLength={64} onChange={e => set("quiet_hours", { ...rule.quiet_hours!, timezone: e.target.value })} /></label></div>}</fieldset>
    <label className="check"><input type="checkbox" checked={rule.assignment ?? false} onChange={e => { set("assignment", e.target.checked); if (!e.target.checked) set("escalation", []); }} />{t.assignment}</label>
    <fieldset className="check-group"><legend>{t.escalation}</legend><small className="muted">{t.escalationHelp}</small>
      {steps.map((step, index) => <div key={index} className="escalation-step" data-testid="escalation-step"><strong>{t.level} {step.level}</strong>
        <label>{t.after}<input type="number" min={1} max={1440} value={Math.round(step.after_seconds / 60)} onChange={e => set("escalation", steps.map((s, i) => i === index ? { ...s, after_seconds: Math.round(Number(e.target.value) * 60) } : s))} /></label>
        <Checks legend={t.roles} name={`step-${index}-roles`} values={roles} selected={step.recipient_roles} label={role => roleLabel(t.roleNames, role, t.otherRole)} change={next => set("escalation", steps.map((s, i) => i === index ? { ...s, recipient_roles: next } : s))} />
        <Checks legend={t.channels} name={`step-${index}-channels`} values={channels} selected={step.channels} label={c => t.channelNames[c]} change={next => set("escalation", steps.map((s, i) => i === index ? { ...s, channels: next } : s))} />
        <button type="button" className="quiet" onClick={() => set("escalation", steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, level: i + 1 })))}>{t.removeStep}</button></div>)}
      {steps.length < 5 && <button type="button" className="secondary" disabled={!rule.assignment} onClick={() => set("escalation", [...steps, { level: steps.length + 1, after_seconds: ((steps.at(-1)?.after_seconds ?? 0) + 600), recipient_roles: ["supervisor"], channels: ["in_app"] }])}>{t.addStep}</button>}</fieldset>
    <label className="check"><input type="checkbox" checked={rule.enabled ?? true} onChange={e => set("enabled", e.target.checked)} />{t.enabled}</label>
    {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
    <ActionStatus status={status} locale={locale} />
    <div className="actions"><button disabled={busy}>{busy ? m.review.saving : t.save}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t.cancel}</button></div>
  </form>;
}
