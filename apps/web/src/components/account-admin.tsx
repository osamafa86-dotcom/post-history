"use client";
import { useState } from "react";
import { browserApi } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import type { Permission, UserStatus } from "@/lib/types";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { permissions, reasonLimits } from "@/lib/admin-policy";
import { permissionLabel as label } from "@/lib/admin-labels";
import { IdentitySetting } from "./identity-setting";
import { PermissionHistory } from "./permission-history";

// حالة تأكيد واجهة؛ الأنواع المنقولة إلى API مستمدة من العقد.
type Intent = { id: string } & ({ kind: "grant"; permission: Permission; reason: string } | { kind: "revoke"; permission: Permission; reason: string } | { kind: "status"; status: UserStatus });
export function AccountAdmin({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.admin, me = useUser(), mutation = useMutation();
  const [id, setId] = useState(""), [reason, setReason] = useState(""), [intent, setIntent] = useState<Intent | null>(null);
  const [revision, setRevision] = useState(0);
  function confirm(action: Intent) { mutation.clearStatus(); setIntent(action); }
  if (!hasRole(me, "system_admin")) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;
  const valid = uuid.test(id), permissionLabel = (p: Permission) => label(p, locale);
  async function apply() {
    if (!intent) return;
    const action = intent;
    const ok = await mutation.run(JSON.stringify(action), header => {
      if (action.kind === "status") return browserApi().PUT("/users/{id}/status", { params: { path: { id: action.id }, header }, body: { status: action.status } });
      const params = { path: { id: action.id, permission: action.permission }, header };
      return action.kind === "grant" ? browserApi().PUT("/users/{id}/permissions/{permission}", { params, body: { reason: action.reason } }) : browserApi().DELETE("/users/{id}/permissions/{permission}", { params });
    });
    if (ok) { setIntent(null); setReason(""); setRevision(n => n + 1); }
  }
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <section className="card form-card admin-target"><label>{t.target}<input dir="ltr" autoComplete="off" value={id} disabled={mutation.busy} onChange={e => setId(e.target.value.trim())} /></label><p className="muted">{t.targetHelp}</p></section>
    <section className="card"><h2>{t.permissions}</h2><label className="reason-field">{t.reason}<textarea aria-label={t.reason} maxLength={reasonLimits.permission} value={reason} disabled={mutation.busy} onChange={e => setReason(e.target.value)} /></label><p className="muted">{t.reasonHelp}</p>
      <div className="permission-grid">{permissions.map(permission => <article key={permission} aria-label={permissionLabel(permission)}><h3>{permissionLabel(permission)}</h3><div className="actions"><button disabled={!valid || !reason.trim() || mutation.busy} onClick={() => confirm({ id, kind: "grant", permission, reason })}>{t.grant}</button><button className="secondary" disabled={!valid || mutation.busy} onClick={() => confirm({ id, kind: "revoke", permission, reason: "" })}>{t.revoke}</button></div></article>)}</div>
    </section>
    <PermissionHistory key={id} id={id} revision={revision} locale={locale} />
    <section className="card"><h2>{t.status}</h2><p className="muted">{t.statusHelp}</p>{id === me.user_id && <p className="notice">{t.self}</p>}<div className="actions"><button className="danger" disabled={!valid || id === me.user_id || mutation.busy} onClick={() => confirm({ id, kind: "status", status: "suspended" })}>{t.suspend}</button><button className="secondary" disabled={!valid || mutation.busy} onClick={() => confirm({ id, kind: "status", status: "active" })}>{t.activate}</button></div></section>
    {!intent && <ActionStatus status={mutation.status} locale={locale} />}
    <IdentitySetting locale={locale} onChanged={() => setRevision(n => n + 1)} />
    {intent && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} aria-labelledby="confirm-action-title" onCancel={event => { if (mutation.busy) event.preventDefault(); else setIntent(null); }}><h2 id="confirm-action-title">{t.confirm}</h2><p>{intent.kind === "grant" ? t.grantWarning : intent.kind === "revoke" ? t.revokeWarning : intent.status === "suspended" ? t.suspendWarning : t.activateWarning}</p><p><bdi>{intent.id}</bdi></p>{intent.kind !== "status" && <p>{permissionLabel(intent.permission)}</p>}
      <ActionStatus status={mutation.status} locale={locale} /><div className="actions"><button autoFocus className="secondary" disabled={mutation.busy} onClick={() => setIntent(null)}>{m.cancel}</button><button disabled={mutation.busy} onClick={() => void apply()}>{mutation.busy ? m.review.saving : t.confirm}</button></div></dialog>}
  </>;
}
