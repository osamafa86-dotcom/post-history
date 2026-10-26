"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { localized } from "@/lib/store-format";
import { buyerRoles, emptyOrganization, inputOf, memberInvite, memberManagers, organizationAdmins, organizationCreate, organizationEditors, organizationInput, organizationLimits, organizationStatuses, type InviteToken, type Member, type Organization, type OrganizationCreate, type OrganizationInput } from "@/lib/buyer-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";

type Status = typeof organizationStatuses[number];

/** لوحة مؤسسات المشترين لمدير النظام (والمالية قراءة). */
export function BuyerOrganizations({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.buyers, me = useUser(), admin = hasRole(me, "system_admin"), allowed = hasRole(me, ...organizationAdmins), mutation = useMutation();
  const [items, setItems] = useState<Organization[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0), [status, setStatus] = useState<Status | "">("");
  const [creating, setCreating] = useState<OrganizationCreate | null>(null), [invalid, setInvalid] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ token: InviteToken; email: string } | null>(null);
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    void browserApi().GET("/buyer-organizations", { params: { query: status ? { status } : {} }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [attempt, allowed, status]);
  if (!allowed) return <section className="center-state"><h1>{t.title}</h1><p role="alert">{t.denied}</p></section>;
  async function create() {
    if (!creating) return;
    const input = organizationCreate(creating as unknown as Record<string, unknown>);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    let token: InviteToken = {};
    const ok = await mutation.run(JSON.stringify(input), async header => { const result = await browserApi().POST("/buyer-organizations", { params: { header }, body: input }); token = { invite_token: result.data?.invite_token, invite_token_expires_at: result.data?.invite_token_expires_at }; return result; });
    if (ok) { setIssued({ token, email: input.first_admin_email }); setCreating(null); setAttempt(n => n + 1); }
  }
  if (selected) return <><button className="quiet back-link" onClick={() => { setSelected(null); setAttempt(n => n + 1); }}>{t.back}</button><OrganizationPanel locale={locale} id={selected} /></>;
  if (issued) return <OneTimeToken locale={locale} token={issued.token} email={issued.email} onDone={() => setIssued(null)} />;
  return <><div className="page-heading"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p>{!admin && <p className="notice">{t.readOnly}</p>}</div>{admin && !creating && <button onClick={() => { mutation.clearStatus(); setInvalid(false); setCreating(emptyOrganization()); }}>{t.new}</button>}</div>
    {creating ? <form className="card form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); void create(); }}>
      <ProfileFields locale={locale} value={creating} set={(key, value) => setCreating(c => c && { ...c, [key]: value })} admin />
      <label>{t.firstAdmin}<input type="email" dir="ltr" maxLength={organizationLimits.email} value={creating.first_admin_email} onChange={e => setCreating(c => c && { ...c, first_admin_email: e.target.value })} /><small className="muted">{t.firstAdminHelp}</small></label>
      {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
      <ActionStatus status={mutation.status} locale={locale} />
      <div className="actions"><button disabled={mutation.busy}>{t.create}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => setCreating(null)}>{t.cancel}</button></div>
    </form> : <>
      <ActionStatus status={mutation.status} locale={locale} />
      <label className="inline-filter">{t.status}<select value={status} onChange={e => { setItems(null); setStatus(e.target.value as Status | ""); }}><option value="">{m.all}</option>{organizationStatuses.map(s => <option key={s} value={s}>{t.statuses[s]}</option>)}</select></label>
      {error ? <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>
        : !items ? <p className="center-state" role="status">{m.loading}</p>
        : !items.length ? <p className="empty">{t.empty}</p>
        : <div className="table-panel"><div className="table-scroll"><table><thead><tr>{[t.displayName, t.country, t.status, t.members, t.createdAt, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{items.map(item => <tr key={item.id} data-testid="organization-row"><td>{localized(item.display_name, locale)}</td><td dir="ltr">{item.country}</td><td><span className={`badge ${item.status === "active" ? "good" : item.status === "suspended" ? "bad" : ""}`}>{t.statuses[item.status ?? "pending_verification"]}</span></td><td>{item.active_members} / {item.seats}</td><td>{formatDate(item.created_at, locale)}</td><td><button className="secondary" onClick={() => setSelected(item.id)}>{t.open}</button></td></tr>)}</tbody></table></div></div>}
    </>}
  </>;
}

/** صفحة مؤسسة المشتري لأعضائها. */
export function MyOrganization({ locale }: { locale: Locale }) {
  const me = useUser(), t = messages[locale].buyers;
  return me.organization_id ? <OrganizationPanel locale={locale} id={me.organization_id} /> : <section className="center-state"><p role="alert">{t.noOrganization}</p></section>;
}

function ProfileFields<T extends OrganizationInput>({ locale, value, set, admin }: { locale: Locale; value: T; set: <K extends keyof OrganizationInput>(key: K, value: OrganizationInput[K]) => void; admin: boolean }) {
  const t = messages[locale].buyers, names = { ar: messages[locale].templates.arabic, en: messages[locale].templates.english };
  return <>
    <label>{t.legalName}<input maxLength={organizationLimits.legalName} value={value.legal_name} onChange={e => set("legal_name", e.target.value)} /></label>
    <fieldset className="check-group bilingual"><legend>{t.displayName}</legend>{(["ar", "en"] as const).map(lang => <label key={lang}>{names[lang]}<input lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} maxLength={4000} value={value.display_name[lang]} onChange={e => set("display_name", { ...value.display_name, [lang]: e.target.value })} /></label>)}</fieldset>
    <div className="rule-row"><label>{t.country}<input dir="ltr" maxLength={2} value={value.country} onChange={e => set("country", e.target.value.toUpperCase())} /><small className="muted">{t.countryHelp}</small></label>
      <label>{t.billingEmail}<input type="email" dir="ltr" maxLength={organizationLimits.email} value={value.billing_email} onChange={e => set("billing_email", e.target.value)} /></label></div>
    <div className="rule-row"><label>{t.seats}<input type="number" min={organizationLimits.seatsMin} max={organizationLimits.seatsMax} value={value.seats} disabled={!admin} onChange={e => set("seats", Number(e.target.value))} /></label>
      {value.status !== undefined && <label>{t.status}<select value={value.status} disabled={!admin} onChange={e => set("status", e.target.value as Status)}>{organizationStatuses.map(s => <option key={s} value={s}>{t.statuses[s]}</option>)}</select></label>}</div>
    {!admin && <small className="muted">{t.adminOnly}</small>}
  </>;
}

/** ملف المؤسسة وأعضاؤها؛ عزل المستأجرين في الخادم والـBFF معًا. */
function OrganizationPanel({ locale, id }: { locale: Locale; id: string }) {
  const m = messages[locale], t = m.buyers, me = useUser(), admin = hasRole(me, "system_admin"), editor = hasRole(me, ...organizationEditors), mutation = useMutation();
  const [loaded, setLoaded] = useState<{ organization: Organization; tag: string | null } | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<OrganizationInput | null>(null), [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/buyer-organizations/{org_id}", { params: { path: { org_id: id } }, signal: controller.signal }).then(result => { const data = dataOrThrow(result); if (!controller.signal.aborted) { setLoaded({ organization: data, tag: result.response.headers.get("ETag") }); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [id, attempt]);
  async function save() {
    if (!draft || !loaded) return;
    const input = organizationInput(draft as unknown as Record<string, unknown>);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    const tag = loaded.tag;
    const ok = await mutation.run(JSON.stringify([id, tag, input]), header => browserApi().PUT("/buyer-organizations/{org_id}", { params: { path: { org_id: id }, header: { ...header, "If-Match": tag ?? "" } }, body: input }));
    if (ok) { setDraft(null); setAttempt(n => n + 1); }
  }
  if (error) return <section className="center-state" role="alert"><p>{m.error}</p><button onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></section>;
  if (!loaded) return <p className="center-state" role="status">{m.loading}</p>;
  const o = loaded.organization;
  return <>
    <div className="page-heading"><div><p className="eyebrow">{t.organization}</p><h1>{localized(o.display_name, locale)}</h1><p className="muted"><span className={`badge ${o.status === "active" ? "good" : o.status === "suspended" ? "bad" : ""}`} data-testid="organization-status">{t.statuses[o.status ?? "pending_verification"]}</span></p></div>
      {editor && !draft && <button onClick={() => { mutation.clearStatus(); setInvalid(false); setDraft(inputOf(o)); }}>{t.edit}</button>}</div>
    {o.status === "pending_verification" && <p className="notice">{t.pendingHelp}</p>}
    {o.status === "suspended" && <p className="notice error">{t.suspendedHelp}</p>}
    {draft ? <form className="card form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); void save(); }}>
      <ProfileFields locale={locale} value={draft} set={(key, value) => setDraft(d => d && { ...d, [key]: value })} admin={admin} />
      {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
      <ActionStatus status={mutation.status} locale={locale} />
      <div className="actions"><button disabled={mutation.busy}>{t.save}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => setDraft(null)}>{t.cancel}</button></div>
    </form> : <section className="card"><ActionStatus status={mutation.status} locale={locale} /><dl className="metadata" data-testid="organization-profile">{[
      [t.legalName, o.legal_name], [t.country, o.country], [t.billingEmail, o.billing_email], [t.members, `${o.active_members} / ${o.seats}`], [t.verifiedAt, formatDate(o.verified_at, locale)],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>}
    {hasRole(me, ...memberManagers) && <Members locale={locale} id={id} seats={o.seats ?? 0} />}
  </>;
}

function Members({ locale, id, seats }: { locale: Locale; id: string; seats: number }) {
  const m = messages[locale], t = m.buyers, mutation = useMutation();
  const [items, setItems] = useState<Member[] | null>(null), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const [invite, setInvite] = useState<{ email: string; role: typeof buyerRoles[number] }>({ email: "", role: "buyer_member" }), [invalid, setInvalid] = useState(false);
  const [issued, setIssued] = useState<{ token: InviteToken; email: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/buyer-organizations/{org_id}/members", { params: { path: { org_id: id } }, signal: controller.signal }).then(dataOrThrow).then(data => { if (!controller.signal.aborted) { setItems(data.items); setError(false); } }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [id, attempt]);
  async function send() {
    const input = memberInvite(invite);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    let token: InviteToken = {};
    const ok = await mutation.run(JSON.stringify(["invite", id, input]), async header => { const result = await browserApi().POST("/buyer-organizations/{org_id}/members", { params: { path: { org_id: id }, header }, body: input }); token = { invite_token: result.data?.invite_token, invite_token_expires_at: result.data?.invite_token_expires_at }; return result; });
    if (ok) { setIssued({ token, email: input.email }); setInvite({ email: "", role: "buyer_member" }); setAttempt(n => n + 1); }
  }
  async function update(member: Member, role: Member["role"], status: "active" | "suspended") {
    const ok = await mutation.run(JSON.stringify(["update", id, member.user_id, role, status]), header => browserApi().PUT("/buyer-organizations/{org_id}/members/{user_id}", { params: { path: { org_id: id, user_id: member.user_id }, header }, body: { role, status } }));
    if (ok) setAttempt(n => n + 1);
  }
  // المدعو يشغل مقعدًا حتى يُعلَّق؛ العدّ من القائمة نفسها حتى لا يتأخر عن الدعوة.
  const active = items?.filter(member => member.status !== "suspended").length ?? 0;
  return <section className="card" aria-labelledby="members-title"><h2 id="members-title">{t.members}</h2>
    {issued && <OneTimeToken locale={locale} token={issued.token} email={issued.email} onDone={() => setIssued(null)} />}
    <p className="muted">{t.seatsUsed.replace("{active}", String(active)).replace("{seats}", String(seats))}</p>
    <ActionStatus status={mutation.status} locale={locale} />
    {mutation.status === 409 && <p className="notice error">{t.memberConflict}</p>}
    {error ? <p role="alert">{m.error}</p> : !items ? <p role="status">{m.loading}</p> : !items.length ? <p className="muted">{t.noMembers}</p>
      : <div className="table-scroll"><table><thead><tr>{[t.email, t.role, t.status, t.totp, ""].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{items.map(member => <tr key={member.user_id} data-testid="member-row"><td dir="ltr">{member.email}</td>
          <td><select aria-label={t.role} value={member.role} disabled={mutation.busy || member.status === "invited"} onChange={e => void update(member, e.target.value as Member["role"], member.status === "suspended" ? "suspended" : "active")}>{buyerRoles.map(r => <option key={r} value={r}>{t.roles[r]}</option>)}</select></td>
          <td>{t.memberStatuses[member.status]}</td><td>{member.totp_enabled ? t.yes : t.no}</td>
          <td>{member.status !== "invited" && <button className="secondary" disabled={mutation.busy} onClick={() => void update(member, member.role, member.status === "suspended" ? "active" : "suspended")}>{member.status === "suspended" ? t.reactivate : t.suspend}</button>}</td></tr>)}</tbody></table></div>}
    <form className="rule-row invite-form" noValidate onSubmit={e => { e.preventDefault(); void send(); }}>
      <label>{t.inviteEmail}<input type="email" dir="ltr" maxLength={organizationLimits.email} value={invite.email} onChange={e => setInvite(v => ({ ...v, email: e.target.value }))} /></label>
      <label>{t.role}<select value={invite.role} onChange={e => setInvite(v => ({ ...v, role: e.target.value as typeof buyerRoles[number] }))}>{buyerRoles.map(r => <option key={r} value={r}>{t.roles[r]}</option>)}</select></label>
      <div className="actions"><button disabled={mutation.busy || !items || active >= seats}>{t.invite}</button></div>
    </form>
    {items && active >= seats && <p className="muted">{t.seatsFull}</p>}
    {invalid && <p className="notice error" role="alert">{t.inviteInvalid}</p>}
    <p className="muted">{t.inviteHelp}</p>
  </section>;
}

/** رمز الدعوة يُعرض مرة واحدة: في الذاكرة وحدها، بلا زر نسخ ولا حفظ، ويزول بالإغلاق أو مغادرة الصفحة. */
function OneTimeToken({ locale, token, email, onDone }: { locale: Locale; token: InviteToken; email: string; onDone: () => void }) {
  const t = messages[locale].buyers;
  if (!token.invite_token) return <section className="notice" role="status"><p>{t.tokenMissing}</p><button className="secondary" onClick={onDone}>{t.done}</button></section>;
  return <section className="card one-time-token" role="alert" aria-labelledby="token-title"><h2 id="token-title">{t.tokenTitle}</h2>
    <p>{t.tokenFor} <bdi dir="ltr">{email}</bdi></p>
    <output className="token-value" dir="ltr" data-testid="invite-token">{token.invite_token}</output>
    <p className="muted">{t.tokenExpires} {formatDate(token.invite_token_expires_at, locale)}</p>
    <p className="notice">{t.tokenOnce}</p>
    <button onClick={onDone}>{t.done}</button></section>;
}
