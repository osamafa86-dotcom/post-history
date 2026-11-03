"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { cleanText, fill, stripHidden } from "@/lib/admin-text";
import { capabilities, staffLimits, staffReaders, staffRoles, type StaffUser, type StaffUserPage } from "@/lib/staff-policy";
import { permissions, reasonLimits } from "@/lib/admin-policy";
import { permissionLabel } from "@/lib/admin-labels";
import type { Permission, RoleName } from "@/lib/types";
import { useMutation } from "@/lib/use-mutation";
import { useUser } from "./session-boundary";
import { EmptyState, NoAccess } from "./empty-state";
import { ActionStatus } from "./action-status";
import { Avatar, ConfirmDialog, ToneBadge, relativeTime, useDebounced } from "./admin-parts";
import { Icon, type IconName } from "./icon";
import { WorkNameEditor } from "./work-name-editor";
import { PermissionHistory } from "./permission-history";

type Filter = "all" | "suspended" | (typeof staffRoles)[number];
const roleIcons: Record<string, IconName> = { reporter: "upload", supervisor: "inbox", producer: "film", editor_in_chief: "pencil", rights_officer: "shield", finance: "money", system_admin: "key" };
export const staffStatusTone = { active: { tone: "ok", icon: "check" }, suspended: { tone: "danger", icon: "ban" }, recovery: { tone: "warn", icon: "key" } } as const;

/**
 * المستخدمون والأدوار (A1، ADR 0099): القائمة من `GET /users` بلا بريد، وسطر الرأس من `summary` على كل الطاقم، والبحث في اسم العمل
 * والبريد دون عرضه، ورقاقات الدور والمعلّق، وشارات الدور والحالة بكلمة، ومصفوفة «ما يستطيعه كل دور». «دعوة مستخدم» لا تُرسم: الحسابات
 * من أمر `create-user` على الخادم (ADR 0030).
 */
export function UsersAdmin({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.admin, me = useUser(), allowed = hasRole(me, ...staffReaders);
  const [filter, setFilter] = useState<Filter>("all"), [search, setSearch] = useState(""), q = useDebounced(cleanText(search).slice(0, 400), 300);
  const [page, setPage] = useState<StaffUserPage | null>(null), [extra, setExtra] = useState<StaffUser[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false), [more, setMore] = useState(false), [attempt, setAttempt] = useState(0), [selected, setSelected] = useState<StaffUser | null>(null);
  const valid = !q || Array.from(q).length <= staffLimits.q;
  const query = { limit: staffLimits.page, ...(filter === "suspended" ? { status: "suspended" as const } : filter !== "all" ? { role: [filter] } : {}), ...(q && valid ? { q } : {}) };
  const key = JSON.stringify(query);
  useEffect(() => {
    if (!allowed || selected || !valid) return;
    const controller = new AbortController();
    void browserApi().GET("/users", { params: { query: JSON.parse(key) }, signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) { setPage(data); setExtra([]); setCursor(data.next_cursor); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [allowed, key, attempt, selected, valid]);
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;
  if (selected) return <AccountView key={selected.id} user={selected} locale={locale} onBack={() => { setSelected(null); setAttempt(n => n + 1); }} />;
  async function loadMore() {
    if (!cursor) return; setMore(true);
    try { const data = dataOrThrow(await browserApi().GET("/users", { params: { query: { ...JSON.parse(key), cursor } } })); setExtra(old => [...old, ...data.items]); setCursor(data.next_cursor); }
    catch { setFailed(true); } finally { setMore(false); }
  }
  const items = page ? [...page.items, ...extra] : null, summary = page?.summary;
  const counts = summary ? staffRoles.map(role => [role, summary.roles.find(row => row.role === role)?.count ?? 0] as const).filter(([, n]) => n > 0) : [];
  const line = summary ? [plural(summary.total, t.users as PluralForms, locale), ...counts.map(([role, n]) => plural(n, (t.rolePlurals as Record<string, PluralForms>)[role], locale)), ...(summary.suspended ? [plural(summary.suspended, t.suspendedPlural as PluralForms, locale)] : [])].join(" · ") : null;
  const filtered = filter !== "all" || !!q;
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted" data-testid="staff-summary">{line ?? <span className="skeleton line" aria-hidden="true" />}</p></div></div>
    <p className="caption admin-note"><Icon name="key" size={14} /> {t.createNote}</p>
    <div className="admin-toolbar">
      <form role="search" className="admin-search" onSubmit={event => event.preventDefault()}>
        <label htmlFor="staff-search" className="visually-hidden">{t.searchLabel}</label>
        <span className="search-icon"><Icon name="search" /></span>
        <input id="staff-search" type="search" value={search} maxLength={staffLimits.q} placeholder={t.searchLabel} aria-describedby="staff-search-help" autoComplete="off" onChange={event => setSearch(stripHidden(event.target.value))} />
        <small id="staff-search-help" className="visually-hidden">{t.searchHelp}</small>
      </form>
      <nav className="quick-tabs" aria-label={t.filtersLabel}>{(["all", ...staffRoles, "suspended"] as Filter[]).map(value => <button key={value} type="button" className={filter === value ? "chip active" : "chip"} aria-pressed={filter === value} onClick={() => { if (value !== filter) { setFilter(value); setPage(null); } }}>{(t.chips as Record<string, string>)[value]}</button>)}</nav>
    </div>
    {failed && <p className="notice error" role="alert">{page ? m.stale : m.error} <button type="button" className="link-button" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
    <section aria-label={t.title} aria-busy={!items}>
      {!items ? (failed ? null : <TableSkeleton columns={6} label={m.loading} />)
        : !items.length ? <EmptyState icon="users" testId="staff-empty" title={filtered ? t.emptyFiltered : t.empty} actions={filtered ? <button type="button" className="secondary" onClick={() => { setFilter("all"); setSearch(""); }}>{t.clearFilters}</button> : undefined}><p>{filtered ? t.emptyFilteredBody : t.emptyBody}</p></EmptyState>
        : <div className="table-panel"><table className="admin-table staff-table">
          <thead><tr><th scope="col">{t.columns.name}</th><th scope="col">{t.columns.roles}</th><th scope="col">{t.columns.governorate}</th><th scope="col">{t.columns.lastActive}</th><th scope="col">{t.columns.status}</th><th scope="col"><span className="visually-hidden">{t.columns.actions}</span></th></tr></thead>
          <tbody>{items.map(user => <StaffRow key={user.id} user={user} locale={locale} onOpen={() => setSelected(user)} />)}</tbody>
        </table>
        {cursor && <div className="pagination"><button type="button" className="secondary" disabled={more} onClick={() => void loadMore()}>{t.loadMore}</button></div>}</div>}
    </section>
    <CapabilityMatrix locale={locale} />
  </>;
}

export function TableSkeleton({ columns, label, rows = 4 }: { columns: number; label: string; rows?: number }) {
  return <><p className="visually-hidden" role="status">{label}</p><div className="table-panel" aria-hidden="true"><table className="admin-table"><tbody>{Array.from({ length: rows }, (_, i) => <tr key={i} className="skeleton-row">{Array.from({ length: columns }, (_, j) => <td key={j}><span className={`skeleton line${j === 0 ? " wide" : ""}`} /></td>)}</tr>)}</tbody></table></div></>;
}

function nameOf(user: StaffUser, locale: Locale) { return user.work_name ?? fill(messages[locale].admin.unnamed, { id: user.id.slice(0, 8) }); }

function RoleBadges({ roles, locale }: { roles: RoleName[]; locale: Locale }) {
  const labels = messages[locale].topbar.roles as Record<string, string>;
  return <span className="role-badges">{roles.map(role => <span key={role} className="badge role" data-role={role}><Icon name={roleIcons[role] ?? "users"} size={14} />{labels[role] ?? role}</span>)}</span>;
}
function StatusBadge({ status, locale }: { status: StaffUser["status"]; locale: Locale }) {
  const { tone, icon } = staffStatusTone[status];
  return <ToneBadge tone={tone} icon={icon} testId="staff-status">{messages[locale].admin.statuses[status]}</ToneBadge>;
}

function StaffRow({ user, locale, onOpen }: { user: StaffUser; locale: Locale; onOpen: () => void }) {
  const t = messages[locale].admin, name = nameOf(user, locale);
  return <tr data-testid="staff-row">
    <td className="cell-primary"><span className="person"><Avatar name={user.work_name} fallback="?" /><span className="person-name"><strong><bdi>{name}</bdi></strong>{!user.work_name && <small className="muted">{t.noWorkName}</small>}</span></span></td>
    <td data-label={t.columns.roles}><RoleBadges roles={user.roles} locale={locale} /></td>
    <td data-label={t.columns.governorate}>{user.governorate ?? <span className="muted" aria-label={t.noGovernorate}>—</span>}</td>
    <td data-label={t.columns.lastActive}><span className="muted">{relativeTime(user.last_active_at, locale) ?? t.never}</span></td>
    <td data-label={t.columns.status}><StatusBadge status={user.status} locale={locale} /></td>
    <td className="cell-action"><button type="button" className="icon-button" aria-label={fill(t.manage, { name })} onClick={onOpen}><Icon name="more" /></button></td>
  </tr>;
}

/** «ما يستطيعه كل دور»: علامة وكلمة في كل خلية، من ثوابت الأدوار المطابقة للعقد. */
function CapabilityMatrix({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.admin, labels = m.topbar.roles as Record<string, string>;
  return <section className="card matrix-card" aria-labelledby="matrix-title">
    <h2 id="matrix-title">{t.matrixTitle}</h2><p className="muted">{t.matrixLead}</p>
    <div className="table-scroll"><table className="matrix">
      <thead><tr><th scope="col">{t.capability}</th>{staffRoles.map(role => <th scope="col" key={role}>{labels[role]}</th>)}</tr></thead>
      <tbody>{capabilities.map(row => <tr key={row.key}><th scope="row">{(t.capabilities as Record<string, string>)[row.key]}</th>{staffRoles.map(role => {
        const yes = (row.roles as readonly string[]).includes(role);
        return <td key={role} className={yes ? "cap yes" : "cap no"}>{yes ? <span className="cap-mark"><Icon name="check" size={14} /><span>{t.can}</span></span> : <><span aria-hidden="true">—</span><span className="visually-hidden">{t.cannot}</span></>}</td>;
      })}</tr>)}</tbody>
    </table></div>
    <ul className="matrix-list">{capabilities.map(row => <li key={row.key}><strong>{(t.capabilities as Record<string, string>)[row.key]}</strong><RoleBadges roles={staffRoles.filter(role => (row.roles as readonly string[]).includes(role))} locale={locale} /></li>)}</ul>
  </section>;
}

type Intent = { kind: "grant" | "revoke"; permission: Permission; reason: string } | { kind: "status"; status: "active" | "suspended" };

/** إدارة حساب واحد: اسم العمل والصلاحيات المستقلة وحالة الحساب وسجل الصلاحيات، كلٌّ بنقطته القائمة بمعرّفه. كل تغيير بتأكيد يقول أثره. */
function AccountView({ user, locale, onBack }: { user: StaffUser; locale: Locale; onBack: () => void }) {
  const m = messages[locale], t = m.admin, me = useUser(), mutation = useMutation();
  const [status, setStatus] = useState(user.status), [reason, setReason] = useState(""), [intent, setIntent] = useState<Intent | null>(null), [revision, setRevision] = useState(0), [done, setDone] = useState("");
  const name = nameOf(user, locale), self = user.id === me.user_id, otherAdmin = !self && user.roles.includes("system_admin");
  async function apply() {
    if (!intent) return;
    const action = intent, id = user.id;
    const ok = await mutation.run(JSON.stringify([id, action]), header => {
      if (action.kind === "status") return browserApi().PUT("/users/{id}/status", { params: { path: { id }, header }, body: { status: action.status } });
      const params = { path: { id, permission: action.permission }, header };
      return action.kind === "grant" ? browserApi().PUT("/users/{id}/permissions/{permission}", { params, body: { reason: action.reason } }) : browserApi().DELETE("/users/{id}/permissions/{permission}", { params });
    });
    if (ok) {
      setIntent(null); setRevision(n => n + 1);
      if (action.kind === "status") { setStatus(action.status); setDone(action.status === "suspended" ? t.suspended : t.activated); }
      else { setReason(""); setDone(fill(action.kind === "grant" ? t.granted : t.revoked, { permission: permissionLabel(action.permission, locale) })); }
    }
  }
  function ask(action: Intent) { mutation.clearStatus(); setDone(""); setIntent(action); }
  const effect = !intent ? "" : intent.kind === "status" ? fill(intent.status === "suspended" ? t.suspendEffect : t.activateEffect, { name }) : fill(intent.kind === "grant" ? t.grantEffect : t.revokeEffect, { name, permission: permissionLabel(intent.permission, locale) });
  return <>
    <button type="button" className="quiet back-link" onClick={onBack}><Icon name="chevron" /> {t.back}</button>
    <div className="page-head account-head"><div className="person large"><Avatar name={user.work_name} fallback="?" /><div><h1><bdi>{name}</bdi></h1>
      <p className="account-meta"><RoleBadges roles={user.roles} locale={locale} /><StatusBadge status={status} locale={locale} /></p>
      <p className="muted">{[user.governorate, relativeTime(user.last_active_at, locale) ?? t.never].filter(Boolean).join(" · ")} · <span className="mono" dir="ltr">{user.id.slice(0, 8)}</span></p></div></div></div>
    {done && <p className="notice good" role="status">{done}</p>}
    {!intent && mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}
    <div className="account-grid">
      <section className="card" aria-labelledby="account-status-title"><h2 id="account-status-title">{t.status}</h2><p className="muted">{t.statusHelp}</p>
        {self && <p className="notice">{t.self}</p>}{otherAdmin && <p className="notice">{t.adminQuorum}</p>}{status === "recovery" && <p className="notice">{t.recoveryNote}</p>}
        <div className="actions">{status === "suspended" ? <button type="button" className="secondary" disabled={mutation.busy} onClick={() => ask({ kind: "status", status: "active" })}>{t.activate}</button>
          : <button type="button" className="danger" disabled={mutation.busy || self || otherAdmin} onClick={() => ask({ kind: "status", status: "suspended" })}>{t.suspend}</button>}</div>
      </section>
      <section className="card" aria-labelledby="account-permissions-title"><h2 id="account-permissions-title">{t.permissions}</h2><p className="muted">{t.permissionsHelp}</p>
        <label className="reason-field">{t.reason}<textarea maxLength={reasonLimits.permission} value={reason} disabled={mutation.busy} onChange={event => setReason(stripHidden(event.target.value))} /></label><p className="caption">{t.reasonHelp}</p>
        <ul className="permission-list">{permissions.map(permission => <li key={permission}><article aria-label={permissionLabel(permission, locale)}><strong>{permissionLabel(permission, locale)}</strong>
          <div className="actions"><button type="button" className="small" disabled={!reason.trim() || mutation.busy} onClick={() => ask({ kind: "grant", permission, reason: reason.trim() })}>{t.grant}</button><button type="button" className="secondary small" disabled={mutation.busy} onClick={() => ask({ kind: "revoke", permission, reason: "" })}>{t.revoke}</button></div></article></li>)}</ul>
      </section>
    </div>
    <WorkNameEditor id={user.id} locale={locale} />
    <PermissionHistory id={user.id} revision={revision} locale={locale} />
    {intent && <ConfirmDialog locale={locale} testId="confirm-account" title={intent.kind === "status" ? (intent.status === "suspended" ? t.suspend : t.activate) : intent.kind === "grant" ? t.grant : t.revoke} confirm={t.confirm} busy={mutation.busy} status={mutation.status} danger={intent.kind === "status" && intent.status === "suspended"} onConfirm={() => void apply()} onCancel={() => setIntent(null)}>
      <p>{effect}</p>{intent.kind !== "status" && <p className="muted">{t.permissionAudit}</p>}
    </ConfirmDialog>}
  </>;
}
