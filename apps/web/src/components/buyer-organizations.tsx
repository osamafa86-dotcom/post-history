"use client";
import { NoAccess } from "./empty-state";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { useMutation } from "@/lib/use-mutation";
import { localized } from "@/lib/store-format";
import { buyerRoles, emptyOrganization, inputOf, memberInvite, memberManagers, organizationAdmins, organizationCreate, organizationEditors, organizationInput, organizationLimits, organizationStatuses, rejectionReasons, type InviteToken, type Member, type Organization, type OrganizationCreate, type OrganizationInput, type RejectionReason } from "@/lib/buyer-policy";
import { useUser } from "./session-boundary";
import { ActionStatus } from "./action-status";
import { EmptyState } from "./empty-state";
import { Avatar, ConfirmDialog, ToneBadge } from "./admin-parts";
import { TableSkeleton } from "./users-admin";
import { currencySymbol } from "./money-overview";
import { Icon } from "./icon";
import { fill } from "@/lib/admin-text";
import { plural, type PluralForms } from "@/lib/i18n";
import { formatMoney } from "@/lib/store-format";
import { plainAmount, type BuyerPurchaseTotal, type BuyerPurchaseTotalsPage } from "@/lib/finance-reports";
import { fillNodes, Money } from "./money";

type Status = Organization["status"];
const statusTone = { active: { tone: "ok", icon: "check" }, pending_verification: { tone: "warn", icon: "pencil" }, suspended: { tone: "danger", icon: "alert" }, rejected: { tone: "danger", icon: "alert" } } as const;
export function OrganizationStatus({ status, locale, testId }: { status: Status | undefined; locale: Locale; testId?: string }) {
  const value = status ?? "pending_verification", { tone, icon } = statusTone[value];
  return <ToneBadge tone={tone} icon={icon} testId={testId}>{messages[locale].buyers.statuses[value]}</ToneBadge>;
}

/**
 * المؤسسات المشترية (A5): رقاقات الحالة، وجدول بالمؤسسة والبلد والمستخدمين ومشتريات السنة (`GET /buyer-purchase-totals`، ADR 0099)
 * والحالة بكلمة، وبطاقة «طلب انضمام» لكل مؤسسة بانتظار التحقق: البنود الثلاثة معايير مكتوبة بلا حالة لكلٍّ منها (ليست في العقد)، و«تفعيل
 * الحساب» بتأكيد يقول أثره. «رفض» لا يُرسم: لا حالة رفض في العقد. والمالية تقرأ وحدها.
 */
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
  if (!allowed) return <NoAccess locale={locale} me={me} title={t.title} denied={t.denied} />;
  async function create() {
    if (!creating) return;
    const input = organizationCreate(creating as unknown as Record<string, unknown>);
    if (!input) { setInvalid(true); return; }
    setInvalid(false);
    let token: InviteToken = {};
    const ok = await mutation.run(JSON.stringify(input), async header => { const result = await browserApi().POST("/buyer-organizations", { params: { header }, body: input }); token = { invite_token: result.data?.invite_token, invite_token_expires_at: result.data?.invite_token_expires_at }; return result; });
    if (ok) { setIssued({ token, email: input.first_admin_email }); setCreating(null); setAttempt(n => n + 1); }
  }
  if (selected) return <><button className="quiet back-link" onClick={() => { setSelected(null); setAttempt(n => n + 1); }}><Icon name="chevron" /> {t.back}</button><OrganizationPanel locale={locale} id={selected} /></>;
  if (issued) return <OneTimeToken locale={locale} token={issued.token} email={issued.email} onDone={() => setIssued(null)} />;
  const pending = (items ?? []).filter(item => item.status === "pending_verification");
  return <><div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p>{!admin && <p className="notice">{t.readOnly}</p>}</div>{admin && !creating && <div className="page-actions"><button onClick={() => { mutation.clearStatus(); setInvalid(false); setCreating(emptyOrganization()); }}>{t.new}</button></div>}</div>
    {creating ? <form className="card form-card rule-form" noValidate onSubmit={e => { e.preventDefault(); void create(); }}>
      <ProfileFields locale={locale} value={creating} set={(key, value) => setCreating(c => c && { ...c, [key]: value })} admin />
      <label>{t.firstAdmin}<input type="email" dir="ltr" maxLength={organizationLimits.email} value={creating.first_admin_email} onChange={e => setCreating(c => c && { ...c, first_admin_email: e.target.value })} /><small className="muted">{t.firstAdminHelp}</small></label>
      {invalid && <p className="notice error" role="alert">{t.invalid}</p>}
      <ActionStatus status={mutation.status} locale={locale} />
      <div className="actions"><button disabled={mutation.busy}>{t.create}</button><button type="button" className="secondary" disabled={mutation.busy} onClick={() => setCreating(null)}>{t.cancel}</button></div>
    </form> : <>
      <ActionStatus status={mutation.status} locale={locale} />
      <nav className="quick-tabs filter-row" aria-label={t.filtersLabel}>{(["", ...organizationStatuses] as (Status | "")[]).map(value => <button key={value || "all"} type="button" className={status === value ? "chip active" : "chip"} aria-pressed={status === value} onClick={() => { if (value !== status) { setItems(null); setStatus(value); } }}>{value ? t.chips[value] : m.all}</button>)}</nav>
      {error ? <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>
        : !items ? <TableSkeleton columns={6} label={m.loading} />
        : !items.length ? <EmptyState icon="org" testId="organizations-empty" title={status ? t.emptyFiltered : t.empty}><p>{t.emptyBody}</p></EmptyState>
        : <OrganizationTable locale={locale} items={items} open={setSelected} />}
      {pending.map(item => <JoinRequest key={item.id} locale={locale} organization={item} admin={admin} onOpen={() => setSelected(item.id)} onActivated={() => setAttempt(n => n + 1)} />)}
    </>}
  </>;
}

/** مشتريات السنة لكل مؤسسة (ADR 0099): العملة في رأس العمود حين تكون واحدة، وإلا يحمل كل مبلغ رمزه. */
function OrganizationTable({ locale, items, open }: { locale: Locale; items: Organization[]; open: (id: string) => void }) {
  const m = messages[locale], t = m.buyers, year = new Date().getUTCFullYear();
  const [totals, setTotals] = useState<BuyerPurchaseTotal[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      const rows: BuyerPurchaseTotal[] = []; let cursor: string | null = null, pages = 0;
      do { const page: BuyerPurchaseTotalsPage = dataOrThrow(await browserApi().GET("/buyer-purchase-totals", { params: { query: { year, limit: 100, ...(cursor ? { cursor } : {}) } }, signal: controller.signal })); rows.push(...page.items); cursor = page.next_cursor; pages++; } while (cursor && pages < 10);
      return rows;
    }
    load().then(rows => { if (!controller.signal.aborted) { setTotals(rows); setFailed(false); } }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [year]);
  const currencies = [...new Set((totals ?? []).map(row => row.currency))], single = currencies.length <= 1 ? currencies[0] ?? "USD" : null;
  const symbol = single ? currencySymbol(single) : "";
  const heading = fill(single ? t.purchasesIn : t.purchases, { year, cur: symbol });
  return <div className="table-panel"><table className="admin-table organizations-table">
    <thead><tr><th scope="col">{t.organization}</th><th scope="col">{t.country}</th><th scope="col" className="num">{t.members}</th><th scope="col" className="num">{heading}</th><th scope="col">{t.status}</th><th scope="col"><span className="visually-hidden">{t.open}</span></th></tr></thead>
    <tbody>{items.map(item => {
      const name = localized(item.display_name, locale), rows = (totals ?? []).filter(row => row.organization_id === item.id);
      return <tr key={item.id} data-testid="organization-row">
        <td className="cell-primary"><span className="person"><Avatar name={name} fallback="?" /><span className="person-name"><strong><bdi>{name}</bdi></strong><small className="muted">{formatDate(item.created_at, locale)}</small></span></span></td>
        <td data-label={t.country}><span dir="ltr">{item.country}</span></td>
        <td className="num" data-label={t.members}><span dir="auto" data-testid="seats-pair">{fill(t.seatsPair, { active: String(item.active_members), seats: String(item.seats) })}</span></td>
        <td className="num" data-label={heading} data-testid="organization-purchases">{failed ? <span className="muted">{m.notAvailable}</span> : !totals ? <span className="skeleton line" aria-hidden="true" /> : !rows.length ? <span className="muted" dir="ltr">{single ? "0.00" : "—"}</span>
          : rows.map(row => <span key={row.currency} className="purchase"><span dir="ltr">{single ? plainAmount(row.paid, locale) : formatMoney(row.paid, locale)}</span><small className="muted">{plural(row.paid_orders, t.orders as PluralForms, locale)}{row.refunded.amount_minor > 0 && <> · <span data-testid="refunded-part">{fillNodes(t.refundedPart, { amount: <Money price={row.refunded} locale={locale} /> })}</span></>}</small></span>)}</td>
        <td data-label={t.status}><OrganizationStatus status={item.status} locale={locale} /></td>
        <td className="cell-action"><button type="button" className="secondary small" onClick={() => open(item.id)}>{t.open}</button></td>
      </tr>;
    })}</tbody>
  </table>{failed && <p className="caption table-foot" role="alert">{t.purchasesFailed}</p>}</div>;
}

/**
 * «طلب انضمام» (A5، S6): البنود الثلاثة معايير مكتوبة تراجعها الإدارة خارج المنصة، والتفعيل بحالة المؤسسة وحدها بتأكيد يقول أثره.
 * والرفض (ADR 0104، 0105) بسبب من القائمة المغلقة على `POST …/rejection` بإصدار الملف الحالي؛ السبب يراه أعضاء المؤسسة، ولا نص حر.
 */
function JoinRequest({ locale, organization, admin, onOpen, onActivated }: { locale: Locale; organization: Organization; admin: boolean; onOpen: () => void; onActivated: () => void }) {
  const m = messages[locale], t = m.buyers, mutation = useMutation(), [confirming, setConfirming] = useState(false), [stale, setStale] = useState(false), name = localized(organization.display_name, locale);
  const [rejecting, setRejecting] = useState(false), [reason, setReason] = useState<RejectionReason | "">("");
  async function reject() {
    if (!reason) return;
    setStale(false);
    const box: { status?: number } = {}, body = { reason_code: reason };
    const ok = await mutation.run(JSON.stringify(["reject", organization.id, reason]), async header => {
      const read = await browserApi().GET("/buyer-organizations/{org_id}", { params: { path: { org_id: organization.id } } });
      if (!read.data) { box.status = read.response.status; return read; }
      const result = await browserApi().POST("/buyer-organizations/{org_id}/rejection", { params: { path: { org_id: organization.id }, header: { ...header, "If-Match": read.response.headers.get("ETag") ?? "" } }, body });
      box.status = result.response.status; return result;
    });
    if (ok) { setRejecting(false); onActivated(); }
    else if (box.status === 412 || box.status === 409) { setRejecting(false); setStale(true); mutation.clearStatus(); onActivated(); }
  }
  async function activate() {
    setStale(false);
    const box: { status?: number } = {};
    const ok = await mutation.run(JSON.stringify(["activate", organization.id]), async header => {
      // الملف كاملًا بإصداره الحالي (If-Match)، والحالة وحدها تتغيّر.
      const read = await browserApi().GET("/buyer-organizations/{org_id}", { params: { path: { org_id: organization.id } } });
      if (!read.data) { box.status = read.response.status; return read; }
      const input = { ...inputOf(read.data), status: "active" as const };
      const result = await browserApi().PUT("/buyer-organizations/{org_id}", { params: { path: { org_id: organization.id }, header: { ...header, "If-Match": read.response.headers.get("ETag") ?? "" } }, body: input });
      box.status = result.response.status; return result;
    });
    if (ok) { setConfirming(false); onActivated(); }
    else if (box.status === 412) { setConfirming(false); setStale(true); mutation.clearStatus(); onActivated(); }
  }
  return <section className="card join-card" aria-labelledby={`join-${organization.id}`} data-testid="join-request">
    <div className="join-head"><div><h2 id={`join-${organization.id}`}>{fill(t.joinTitle, { name })}</h2><p className="muted">{t.joinLead}</p></div>
      <div className="actions">{admin && <button type="button" disabled={mutation.busy} onClick={() => { mutation.clearStatus(); setConfirming(true); }}>{t.activate}</button>}
        {admin && <button type="button" className="danger" data-testid="reject-request" disabled={mutation.busy} onClick={() => { mutation.clearStatus(); setReason(""); setRejecting(true); }}>{t.reject.action}</button>}
        <button type="button" className="secondary" onClick={onOpen}>{t.open}</button></div></div>
    <ul className="join-checks">{(["registry", "email", "agreement"] as const).map(check => <li key={check}><Icon name="check" size={14} />{t.checks[check]}</li>)}</ul>
    <p className="caption">{t.joinNote}</p>
    {stale && <p className="notice attention" role="alert">{t.changedOrg}</p>}
    {!confirming && !rejecting && mutation.status !== 0 && mutation.status !== 200 && <ActionStatus status={mutation.status} locale={locale} />}
    {rejecting && <ConfirmDialog locale={locale} testId="confirm-reject" title={fill(t.reject.title, { name })} confirm={t.reject.action} busy={mutation.busy} status={mutation.status} danger confirmDisabled={!reason} onConfirm={() => void reject()} onCancel={() => setRejecting(false)}>
      <label>{t.reject.reason}<select data-testid="reject-reason" value={reason} onChange={event => setReason(event.target.value as RejectionReason | "")}><option value="" disabled>{m.choose}</option>{rejectionReasons.map(code => <option key={code} value={code}>{t.reject.reasons[code]}</option>)}</select></label>
      <p>{fill(t.reject.effect, { name })}</p>
    </ConfirmDialog>}
    {confirming && <ConfirmDialog locale={locale} testId="confirm-activate" title={t.activate} confirm={t.activate} busy={mutation.busy} status={mutation.status} onConfirm={() => void activate()} onCancel={() => setConfirming(false)}>
      <p>{fill(t.activateEffect, { name })}</p>
    </ConfirmDialog>}
  </section>;
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
      {value.status !== undefined && <label>{t.status}<select value={value.status} disabled={!admin} onChange={e => set("status", e.target.value as Status)}>{organizationStatuses.filter(s => s !== "rejected" || value.status === "rejected").map(s => <option key={s} value={s}>{t.statuses[s]}</option>)}</select></label>}</div>
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
    <div className="page-heading"><div><p className="eyebrow">{t.organization}</p><h1>{localized(o.display_name, locale)}</h1><p className="muted"><OrganizationStatus status={o.status} locale={locale} testId="organization-status" /></p></div>
      {editor && !draft && <button onClick={() => { mutation.clearStatus(); setInvalid(false); setDraft(inputOf(o)); }}>{t.edit}</button>}</div>
    {o.status === "pending_verification" && <p className="notice">{t.pendingHelp}</p>}
    {o.status === "suspended" && <p className="notice error">{t.suspendedHelp}</p>}
    {o.status === "rejected" && <p className="notice error" data-testid="organization-rejected">{admin ? fill(t.reject.help, { reason: t.reject.reasons[o.rejection_reason ?? "other"] }) : fill(m.store.org.rejected.body, { reason: m.store.org.rejected.reasons[o.rejection_reason ?? "other"] })}</p>}
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
