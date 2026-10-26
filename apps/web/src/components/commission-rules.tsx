"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { materialTypes } from "@/lib/query";
import { licenseTypes } from "@/lib/license-policy";
import { basisPointsMax, commissionInput, commissionReaders, commissionScopes, commissionWriters, currentRules, emptyRule, type CommissionRule, type CommissionRuleInput } from "@/lib/commission-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";

type Scope = CommissionRuleInput["scope"];
const percent = (points: number, locale: Locale) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(points / 10000);

/** قواعد العمولة للمالية: سجل إصدارات لا يُعدَّل؛ مدير النظام يضيف إصدارًا بتاريخ سريان. */
export function CommissionRules({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.commission, me = useUser(), allowed = hasRole(me, ...commissionReaders), writer = hasRole(me, ...commissionWriters), mutation = useMutation();
  const [items, setItems] = useState<CommissionRule[] | null>(null), [checkedAt, setCheckedAt] = useState(0), [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [scope, setScope] = useState<Scope | "">("");
  const [draft, setDraft] = useState<CommissionRuleInput | null>(null), [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/commission-rules", { params: { query: scope ? { scope } : {} }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setCheckedAt(Date.now()); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt, allowed, scope]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;

  async function save() {
    if (!draft) return;
    const at = Date.parse(draft.effective_from), input = commissionInput({ ...draft, effective_from: Number.isFinite(at) ? new Date(at).toISOString() : "" });
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    const ok = await mutation.run(JSON.stringify(input), header => browserApi().POST("/commission-rules", { params: { header }, body: input }));
    if (ok) { setDraft(null); setAttempt(n => n + 1); }
  }
  const start = (from?: CommissionRule) => { mutation.clearStatus(); setInvalid(false); setDraft(from ? { scope: from.scope, scope_id: from.scope_id ?? null, license_type: from.license_type ?? null, platform_basis_points: from.platform_basis_points, effective_from: "" } : emptyRule()); };
  const current = items ? currentRules(items, checkedAt) : new Set<string>();
  const target = (rule: CommissionRule) => rule.scope === "default" ? t.allMaterials : rule.scope === "material_type" ? m.types[rule.scope_id as keyof typeof m.types] ?? rule.scope_id : rule.scope_id;

  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p>{!writer && <p className="notice">{t.readOnly}</p>}</div>{writer && !draft && <button onClick={() => start()}>{t.new}</button>}</div>
    {draft ? <RuleForm locale={locale} draft={draft} set={setDraft} busy={mutation.busy} invalid={invalid} status={mutation.status} onSave={() => void save()} onCancel={() => setDraft(null)} />
      : <><ActionStatus status={mutation.status} locale={locale} />
        <label>{t.scope}<select value={scope} onChange={e => { setItems(null); setScope(e.target.value as Scope | ""); }}><option value="">{m.all}</option>{commissionScopes.map(s => <option key={s} value={s}>{t.scopes[s]}</option>)}</select></label>
        {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
          : !items ? <p className="center-state" role="status">{m.loading}</p>
          : !items.length ? <p className="empty">{t.empty}</p>
          : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[t.scope, t.target, t.licenseType, t.platformShare, t.effectiveFrom, t.state, ""].map((label, i) => <th scope="col" key={i}>{label}</th>)}</tr></thead>
            <tbody>{items.map(rule => <tr key={rule.id} data-testid="commission-row"><td>{t.scopes[rule.scope]}</td><td><bdi dir={rule.scope === "material" || rule.scope === "reporter" ? "ltr" : undefined}>{target(rule)}</bdi></td>
              <td>{rule.license_type ? m.store.licenseTypes[rule.license_type] : t.allTypes}</td><td>{percent(rule.platform_basis_points, locale)}</td><td>{formatDate(rule.effective_from, locale)}</td>
              <td><span className={`badge ${current.has(rule.id) ? "good" : ""}`}>{current.has(rule.id) ? t.current : Date.parse(rule.effective_from) > checkedAt ? t.scheduled : t.superseded}</span></td>
              <td>{writer && <button className="secondary" onClick={() => start(rule)}>{t.newVersion}</button>}</td></tr>)}</tbody></table></div></div>}</>}
  </>;
}

function RuleForm({ locale, draft, set, busy, invalid, status, onSave, onCancel }: { locale: Locale; draft: CommissionRuleInput; set: (next: CommissionRuleInput) => void; busy: boolean; invalid: boolean; status: number; onSave: () => void; onCancel: () => void }) {
  const m = messages[locale], t = m.commission;
  const scopeChange = (scope: Scope) => set({ ...draft, scope, scope_id: scope === "default" ? null : scope === "material_type" ? materialTypes[0] : "" });
  return <form className="card form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); onSave(); }}>
    <p className="notice">{t.appendOnly}</p>
    <div className="rule-row"><label>{t.scope}<select value={draft.scope} onChange={e => scopeChange(e.target.value as Scope)}>{commissionScopes.map(s => <option key={s} value={s}>{t.scopes[s]}</option>)}</select></label>
      {draft.scope === "material_type" && <label>{t.target}<select value={draft.scope_id ?? ""} onChange={e => set({ ...draft, scope_id: e.target.value })}>{materialTypes.map(type => <option key={type} value={type}>{m.types[type]}</option>)}</select></label>}
      {(draft.scope === "material" || draft.scope === "reporter") && <label>{draft.scope === "material" ? t.materialId : t.reporterId}<input dir="ltr" maxLength={36} value={draft.scope_id ?? ""} onChange={e => set({ ...draft, scope_id: e.target.value.trim() })} /></label>}</div>
    <div className="rule-row"><label>{t.licenseType}<select value={draft.license_type ?? ""} onChange={e => set({ ...draft, license_type: (e.target.value || null) as CommissionRuleInput["license_type"] })}><option value="">{t.allTypes}</option>{licenseTypes.map(type => <option key={type} value={type}>{m.store.licenseTypes[type]}</option>)}</select></label>
      <label>{t.platformShare}<input type="number" min={0} max={100} step="0.01" dir="ltr" value={draft.platform_basis_points / 100} onChange={e => set({ ...draft, platform_basis_points: Math.round(Number(e.target.value) * 100) })} /><small className="muted">{t.shareHelp}</small></label></div>
    <label>{t.effectiveFrom}<input type="datetime-local" dir="ltr" value={draft.effective_from} onChange={e => set({ ...draft, effective_from: e.target.value })} /><small className="muted">{t.effectiveHelp}</small></label>
    {invalid && <p className="notice error" role="alert">{t.invalid.replace("{max}", String(basisPointsMax / 100))}</p>}
    <ActionStatus status={status} locale={locale} />
    <div className="actions"><button disabled={busy}>{busy ? m.review.saving : t.save}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>{t.cancel}</button></div>
  </form>;
}
