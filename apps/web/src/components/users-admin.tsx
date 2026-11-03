"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { cleanText, fill, stripHidden } from "@/lib/admin-text";
import { capabilities, editableRoles, rolesInput, roleLimits, sameRoles, staffLimits, staffReaders, staffRoles, type StaffRole, type StaffUser, type StaffUserPage } from "@/lib/staff-policy";
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
import { OneTimeLink } from "./one-time-link";
import { resetLinkFor, resetLinkIssuers, resetReasons, type PasswordResetLink, type ResetReason } from "@/lib/recovery-policy";

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
  const [roles, setRoles] = useState<RoleName[]>(user.roles);
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
      <p className="account-meta"><RoleBadges roles={roles} locale={locale} /><StatusBadge status={status} locale={locale} /></p>
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
    <RolesCard user={user} name={name} locale={locale} onChanged={setRoles} />
    {hasRole(me, ...resetLinkIssuers) && <ResetLinkCard user={user} name={name} status={status} locale={locale} onIssued={() => { setStatus("recovery"); setRevision(n => n + 1); }} />}
    <WorkNameEditor id={user.id} locale={locale} />
    <PermissionHistory id={user.id} revision={revision} locale={locale} />
    {intent && <ConfirmDialog locale={locale} testId="confirm-account" title={intent.kind === "status" ? (intent.status === "suspended" ? t.suspend : t.activate) : intent.kind === "grant" ? t.grant : t.revoke} confirm={t.confirm} busy={mutation.busy} status={mutation.status} danger={intent.kind === "status" && intent.status === "suspended"} onConfirm={() => void apply()} onCancel={() => setIntent(null)}>
      <p>{effect}</p>{intent.kind !== "status" && <p className="muted">{t.permissionAudit}</p>}
    </ConfirmDialog>}
  </>;
}

/**
 * رابط إعادة التعيين (A1، ADR 0107، 0108): بلا بريد، يتحقق المدير من الهوية خارج النظام ثم يصدر رابطًا لمرة واحدة بسبب، بتأكيد يقول الأثر
 * (خروج من كل الأجهزة وإبطال مفاتيح المرور والرابط السابق). الرابط يُبنى من مصدر الويب نفسه ويُعرض مرة؛ التكرار بالمفتاح نفسه لا يعيده.
 * حسابك وحساب مدير نظام والحساب المعلّق خارجها بسطر يقول السبب.
 */
function ResetLinkCard({ user, name, status, locale, onIssued }: { user: StaffUser; name: string; status: StaffUser["status"]; locale: Locale; onIssued: () => void }) {
  const m = messages[locale], t = m.admin.resetLink, me = useUser(), mutation = useMutation();
  const [reason, setReason] = useState<ResetReason>("forgot_password"), [confirming, setConfirming] = useState(false), [issued, setIssued] = useState<{ link: string; expires: string } | null>(null), [note, setNote] = useState("");
  const self = user.id === me.user_id, otherAdmin = !self && user.roles.includes("system_admin"), suspended = status === "suspended", blocked = self || otherAdmin || suspended;
  async function issue() {
    let data: PasswordResetLink | undefined;
    const ok = await mutation.run(JSON.stringify(["password-reset-link", user.id, reason]), async header => { const result = await browserApi().POST("/users/{id}/password-reset-links", { params: { path: { id: user.id }, header }, body: { reason } }); data = result.data; return result; });
    if (!ok || !data) return;
    setConfirming(false); onIssued();
    if (data.reset_token) setIssued({ link: resetLinkFor(window.location.origin, locale, data.reset_token), expires: data.reset_token_expires_at });
    else setNote(t.notShown);
  }
  return <section className="card reset-link-card" aria-labelledby="reset-link-title" data-testid="reset-link-card">
    <h2 id="reset-link-title">{t.title}</h2><p className="muted">{t.help}</p>
    {self && <p className="notice">{t.self}</p>}{otherAdmin && <p className="notice">{t.adminQuorum}</p>}{suspended && !self && !otherAdmin && <p className="notice">{t.suspended}</p>}
    {note && <p className="notice" role="status">{note}</p>}
    {!confirming && mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}
    {issued ? <OneTimeLink link={issued.link} expiresAt={issued.expires} locale={locale} testId="admin-reset-link" onDone={() => { setIssued(null); mutation.clearStatus(); }} />
      : <div className="reset-link-form">
        <label>{t.reason}<select value={reason} disabled={blocked || mutation.busy} onChange={event => setReason(event.target.value as ResetReason)}>{resetReasons.map(value => <option key={value} value={value}>{t.reasons[value]}</option>)}</select></label>
        <div className="actions"><button type="button" className="secondary" data-testid="issue-reset-link" disabled={blocked || mutation.busy} onClick={() => { mutation.clearStatus(); setNote(""); setConfirming(true); }}><Icon name="key" />{t.issue}</button></div>
      </div>}
    {confirming && <ConfirmDialog locale={locale} testId="confirm-reset-link" title={t.confirmTitle} confirm={t.issue} busy={mutation.busy} status={mutation.status} danger onConfirm={() => void issue()} onCancel={() => setConfirming(false)}>
      <p>{fill(t.effect, { name })}</p><p className="muted">{t.reason}: {t.reasons[reason]}</p>
    </ConfirmDialog>}
  </section>;
}

type RoleDraft = Record<string, { on: boolean; scopes: StaffRole["scopes"] }>;
const draftOf = (roles: StaffRole[]): RoleDraft => Object.fromEntries(editableRoles.map(role => { const found = roles.find(r => r.name === role); return [role, { on: !!found, scopes: found?.scopes ?? [] }]; }));
const rolesOfDraft = (draft: RoleDraft, scoped: boolean): StaffRole[] => editableRoles.filter(role => draft[role]?.on).map(role => ({ name: role, scopes: role === "supervisor" && scoped ? draft[role].scopes : [] }));

/**
 * أدوار الحساب (A1، ADR 0104، 0105): القراءة من `GET /users/{id}/roles`، والتغيير استبدال كامل بتأكيد يقول الأثر. النطاق للمشرف وحده:
 * «كل المكاتب» أو محافظات بالاسم ومكاتب قائمة (لا قائمة مكاتب في العقد، فالمكتب الجديد من سطر الأوامر). حسابك وحساب مدير نظام
 * خارجها بسطر يقول السبب، ودور مدير النظام لا يُمنح من هنا (إجراء الشخصين).
 */
function RolesCard({ user, name, locale, onChanged }: { user: StaffUser; name: string; locale: Locale; onChanged: (roles: RoleName[]) => void }) {
  const m = messages[locale], t = m.admin.roles, labels = m.topbar.roles as Record<string, string>, me = useUser(), mutation = useMutation();
  const [current, setCurrent] = useState<StaffRole[] | null>(null), [failed, setFailed] = useState(false), [draft, setDraft] = useState<RoleDraft | null>(null);
  const [scoped, setScoped] = useState(false), [governorate, setGovernorate] = useState(""), [confirming, setConfirming] = useState(false), [done, setDone] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/users/{id}/roles", { params: { path: { id: user.id } }, signal: controller.signal }).then(dataOrThrow)
      .then(data => { if (!controller.signal.aborted) { setCurrent(data.roles); setFailed(false); } }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [user.id]);
  const self = user.id === me.user_id, admin = (current ?? []).some(role => role.name === "system_admin") || user.roles.includes("system_admin");
  const scopeText = (scope: StaffRole["scopes"][number]) => scope.kind === "office" ? fill(t.scopeOffice, { id: scope.id.slice(0, 8) }) : fill(t.scopeGovernorate, { name: scope.id });
  const describe = (role: StaffRole) => `${labels[role.name] ?? role.name}${role.name === "supervisor" ? ` (${role.scopes.length ? role.scopes.map(scopeText).join(m.shell.listSeparator) : t.scopeAll})` : ""}`;
  const wanted = draft ? rolesOfDraft(draft, scoped) : [], input = draft ? rolesInput({ roles: wanted }) : null;
  const supervisorOn = !!draft?.supervisor?.on, scopeMissing = supervisorOn && scoped && !draft?.supervisor?.scopes.length;
  const unchanged = !!current && sameRoles(wanted, current.filter(role => role.name !== "system_admin"));
  const gov = cleanText(governorate).trim(), govValid = !!gov && Array.from(gov).length <= roleLimits.governorate && !draft?.supervisor?.scopes.some(s => s.kind === "governorate" && s.id === gov);
  function edit() { if (!current) return; mutation.clearStatus(); setDone(false); setDraft(draftOf(current)); setScoped((current.find(r => r.name === "supervisor")?.scopes.length ?? 0) > 0); setGovernorate(""); }
  function toggle(role: string, on: boolean) { setDraft(d => d && { ...d, [role]: { ...d[role], on } }); }
  function setScopes(next: StaffRole["scopes"]) { setDraft(d => d && { ...d, supervisor: { ...d.supervisor, scopes: next } }); }
  async function save() {
    if (!input) return;
    let next: StaffRole[] | undefined;
    const ok = await mutation.run(JSON.stringify([user.id, input]), async header => { const result = await browserApi().PUT("/users/{id}/roles", { params: { path: { id: user.id }, header }, body: input }); next = result.data?.roles; return result; });
    if (ok && next) { setCurrent(next); setDraft(null); setConfirming(false); setDone(true); onChanged(next.map(role => role.name)); }
    else setConfirming(false);
  }
  return <section className="card roles-card" aria-labelledby="account-roles-title" data-testid="roles-card"><h2 id="account-roles-title">{t.title}</h2><p className="muted">{t.help}</p>
    {self && <p className="notice">{t.self}</p>}{!self && admin && <p className="notice">{t.adminQuorum}</p>}
    {failed ? <p className="notice error" role="alert">{t.loadFailed}</p> : !current ? <p role="status" className="muted">{m.loading}</p>
      : !draft ? <>
        <ul className="role-lines" data-testid="role-lines">{current.map(role => <li key={role.name}><Icon name={roleIcons[role.name] ?? "users"} size={14} /><bdi>{describe(role)}</bdi></li>)}</ul>
        {done && <p className="notice good" role="status">{t.changed}</p>}
        <div className="actions"><button type="button" className="secondary" disabled={self || admin || mutation.busy} onClick={edit}>{t.edit}</button></div>
      </> : <form className="roles-form" onSubmit={event => { event.preventDefault(); if (input && !scopeMissing && !unchanged) { mutation.clearStatus(); setConfirming(true); } }}>
        <fieldset className="check-group role-checks"><legend>{t.title}</legend>
          {editableRoles.map(role => <label className="check" key={role}><input type="checkbox" checked={!!draft[role]?.on} disabled={mutation.busy} onChange={event => toggle(role, event.target.checked)} />{labels[role]}</label>)}
        </fieldset>
        <p className="caption">{t.adminNote}</p>
        {supervisorOn && <fieldset className="check-group scope-group" data-testid="scope-group"><legend>{labels.supervisor}</legend>
          <label className="check"><input type="radio" name="scope" checked={!scoped} onChange={() => setScoped(false)} />{t.scopeAll}</label>
          <label className="check"><input type="radio" name="scope" checked={scoped} onChange={() => setScoped(true)} />{t.scopeSome}</label>
          {scoped && <>
            <ul className="scope-chips">{draft.supervisor.scopes.map(scope => <li key={`${scope.kind}:${scope.id}`}><button type="button" className="chip removable" aria-label={fill(t.scopeRemove, { scope: scopeText(scope) })} onClick={() => setScopes(draft.supervisor.scopes.filter(s => s !== scope))}><bdi>{scopeText(scope)}</bdi><Icon name="x" size={14} /></button></li>)}</ul>
            <div className="scope-add"><label>{t.scopeLabel}<input value={governorate} maxLength={roleLimits.governorate} onChange={event => setGovernorate(stripHidden(event.target.value))} /></label>
              <button type="button" className="secondary small" disabled={!govValid || draft.supervisor.scopes.length >= roleLimits.scopes} onClick={() => { setScopes([...draft.supervisor.scopes, { kind: "governorate", id: gov }]); setGovernorate(""); }}>{t.scopeAdd}</button></div>
            <p className="caption">{t.scopeOfficeNote}</p>
            {scopeMissing && <p className="field-hint" role="status">{t.scopeEmpty}</p>}
          </>}
        </fieldset>}
        {!wanted.length && <p className="field-hint" role="status">{t.none}</p>}
        {mutation.status === 422 && <p className="notice error" role="alert">{t.invalid}</p>}
        {!confirming && mutation.status !== 0 && mutation.status !== 200 && mutation.status !== 422 && <ActionStatus status={mutation.status} locale={locale} />}
        <div className="actions"><button type="submit" disabled={!input || scopeMissing || unchanged || mutation.busy}>{t.save}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => setDraft(null)}>{t.cancel}</button></div>
      </form>}
    {confirming && <ConfirmDialog locale={locale} testId="confirm-roles" title={t.edit} confirm={t.save} busy={mutation.busy} status={0} onConfirm={() => void save()} onCancel={() => setConfirming(false)}>
      <p>{fill(t.effect, { name, roles: wanted.map(describe).join(m.shell.listSeparator) })}</p>
    </ConfirmDialog>}
  </section>;
}
