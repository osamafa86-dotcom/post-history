"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { stripHidden } from "@/lib/admin-text";
import { creatableRoles, officeInput, staffAccountInput, type Office, type StaffUser } from "@/lib/staff-policy";
import { useMutation } from "@/lib/use-mutation";

type Role = (typeof creatableRoles)[number];

/**
 * إدارة الطاقم من الصفحة (ADR 0122): حساب جديد بدور واحد، والمكاتب التي يُختار منها نطاق المشرف ومكتب المراسل. لا دور مدير نظام هنا.
 * الحساب يولد بلا كلمة سر: بعد إنشائه تُفتح صفحته ليصدر له المدير رابط إعادة التعيين القائم. المكتب والنطاق يُختاران من القائمة، لا بكتابة معرّف.
 */
export function StaffManagement({ locale, onCreated }: { locale: Locale; onCreated: (user: StaffUser) => void }) {
  const m = messages[locale], t = m.admin.create, [offices, setOffices] = useState<Office[] | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/offices", { signal: controller.signal }).then(result => { const data = dataOrThrow(result); if (!controller.signal.aborted) { setOffices(data.items); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  return <div className="account-grid staff-management" data-testid="staff-management">
    <CreateAccount locale={locale} offices={offices ?? []} onCreated={onCreated} />
    <section className="card" aria-labelledby="offices-title" data-testid="offices-card"><h2 id="offices-title">{t.officesTitle}</h2><p className="muted">{t.officesLead}</p>
      {failed ? <p className="notice error" role="alert">{m.error} <button type="button" className="link-button" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>
        : !offices ? <p role="status" className="muted">{m.loading}</p>
        : offices.length ? <ul className="office-list" data-testid="office-list">{offices.map(office => <li key={office.id}><bdi>{locale === "ar" ? office.name_ar : office.name_en}</bdi> · <span className="muted">{office.governorate}</span></li>)}</ul>
        : <p className="muted">{t.noOffices}</p>}
      <AddOffice locale={locale} onAdded={() => setAttempt(n => n + 1)} />
    </section>
  </div>;
}

function CreateAccount({ locale, offices, onCreated }: { locale: Locale; offices: Office[]; onCreated: (user: StaffUser) => void }) {
  const m = messages[locale], t = m.admin.create, mutation = useMutation();
  const [email, setEmail] = useState(""), [role, setRole] = useState<Role>("producer"), [name, setName] = useState(""), [scope, setScope] = useState("all"), [office, setOffice] = useState(""), [problem, setProblem] = useState("");
  const governorates = [...new Set(offices.map(item => item.governorate))], officeName = (item: Office) => locale === "ar" ? item.name_ar : item.name_en;
  // النطاق قيمة واحدة من القائمة: «كل المكاتب»، أو مكتب بمعرّفه، أو محافظة برمزها
  const [kind, scopeId] = scope === "all" ? ["all", ""] : [scope.slice(0, scope.indexOf(":")), scope.slice(scope.indexOf(":") + 1)];
  const input = staffAccountInput({ email, role, ...(role !== "reporter" && name.trim() ? { work_name: name.trim() } : {}), ...(role === "supervisor" ? { scope_kind: kind, scope_id: scopeId } : {}), ...(role === "reporter" || office ? { office_id: office || null } : {}) });
  async function create() {
    if (!input) { setProblem(t.invalid); return; }
    setProblem("");
    const box: { user?: StaffUser; status?: number; code?: string } = {};
    const ok = await mutation.run(JSON.stringify(input), async header => { const reply = await browserApi().POST("/users", { params: { header }, body: input }); box.user = reply.data; box.status = reply.response.status; box.code = (reply.error as { code?: string } | undefined)?.code; return reply; });
    if (ok && box.user) { setEmail(""); setName(""); onCreated(box.user); return; }
    setProblem(box.status === 409 ? (box.code === "email_taken" ? t.emailTaken : m.error) : box.status === 422 ? t.invalid : box.status === 429 ? t.limited : m.error);
  }
  return <section className="card" aria-labelledby="create-account-title" data-testid="create-account"><h2 id="create-account-title">{t.title}</h2><p className="muted">{t.lead}</p>
    <form className="invite-form" noValidate onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>{t.email}<input type="email" name="new-account-email" dir="ltr" autoComplete="off" maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setProblem(""); }} /></label>
      <label>{t.role}<select name="new-account-role" value={role} onChange={event => { setRole(event.target.value as Role); setProblem(""); }}>{creatableRoles.map(value => <option key={value} value={value}>{(m.topbar.roles as Record<string, string>)[value]}</option>)}</select></label>
      {role !== "reporter" && <label>{t.workName}<input name="new-account-work-name" maxLength={80} autoComplete="off" value={name} onChange={event => setName(stripHidden(event.target.value))} /></label>}
      {role === "supervisor" && <label>{t.scope}<select name="new-account-scope" value={scope} onChange={event => setScope(event.target.value)}><option value="all">{t.allOffices}</option>
        {offices.map(item => <option key={item.id} value={`office:${item.id}`}>{t.officeOption.replace("{name}", officeName(item))}</option>)}
        {governorates.map(value => <option key={value} value={`governorate:${value}`}>{t.governorateOption.replace("{name}", value)}</option>)}</select></label>}
      {role === "reporter" && <label>{t.office}<select name="new-account-office" value={office} onChange={event => { setOffice(event.target.value); setProblem(""); }}><option value="" disabled>{t.chooseOffice}</option>
        {offices.map(item => <option key={item.id} value={item.id}>{officeName(item)}</option>)}</select></label>}
      {role === "reporter" && !offices.length && <p className="caption">{t.noOffices}</p>}
      <p className="caption">{t.noAdmin}</p>
      {problem && <p className="notice error" role="alert" data-testid="create-account-error">{problem}</p>}
      <div className="actions"><button data-testid="create-account-submit" disabled={mutation.busy}>{mutation.busy ? m.review.saving : t.submit}</button></div>
    </form>
  </section>;
}

function AddOffice({ locale, onAdded }: { locale: Locale; onAdded: () => void }) {
  const m = messages[locale], t = m.admin.create, mutation = useMutation();
  const [nameAr, setNameAr] = useState(""), [nameEn, setNameEn] = useState(""), [governorate, setGovernorate] = useState(""), [note, setNote] = useState<{ tone: "good" | "error"; text: string } | null>(null);
  const input = officeInput({ name_ar: nameAr.trim(), name_en: nameEn.trim(), governorate: governorate.trim() });
  async function add() {
    if (!input) { setNote({ tone: "error", text: m.review.invalid }); return; }
    const box: { status?: number; code?: string } = {};
    const ok = await mutation.run(JSON.stringify(input), async header => { const reply = await browserApi().POST("/offices", { params: { header }, body: input }); box.status = reply.response.status; box.code = (reply.error as { code?: string } | undefined)?.code; return reply; });
    if (ok) { setNameAr(""); setNameEn(""); setGovernorate(""); setNote({ tone: "good", text: t.officeDone }); onAdded(); return; }
    setNote({ tone: "error", text: box.status === 409 ? t.officeExists : box.status === 429 ? t.limited : box.status === 422 ? m.review.invalid : m.error });
  }
  return <form className="invite-form" noValidate data-testid="add-office" onSubmit={event => { event.preventDefault(); void add(); }}>
    <label>{t.nameAr}<input name="office-name-ar" dir="rtl" maxLength={120} value={nameAr} onChange={event => { setNameAr(stripHidden(event.target.value)); setNote(null); }} /></label>
    <label>{t.nameEn}<input name="office-name-en" dir="ltr" maxLength={120} value={nameEn} onChange={event => { setNameEn(stripHidden(event.target.value)); setNote(null); }} /></label>
    <label>{t.governorate}<input name="office-governorate" dir="ltr" maxLength={64} value={governorate} onChange={event => { setGovernorate(stripHidden(event.target.value)); setNote(null); }} /></label>
    {note && <p className={`notice ${note.tone}`} role={note.tone === "error" ? "alert" : "status"} data-testid="office-note">{note.text}</p>}
    <div className="actions"><button className="secondary" disabled={mutation.busy}>{t.addOffice}</button></div>
  </form>;
}
