"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { cleanToken, groupSecret, passwordMin, tokenFromHash, validPassword, validToken } from "@/lib/invite-policy";
import { PublicFrame } from "../public-frame";
import { Icon } from "../icon";

type Enrollment = { secret_base32: string; otpauth_uri: string };
type Step = "password" | "totp" | "invalid" | "expired";
// الرمز من جزء الرابط يُقرأ مرة عند أول عرض في المتصفح ثم يُمحى من شريط العنوان؛ الخادم لا يراه (لقطته فارغة).
let captured: string | null | undefined;
function linkToken() {
  if (captured === undefined) { captured = tokenFromHash(window.location.hash); if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search); }
  return captured;
}
const still = () => () => {};
async function post(path: "recovery/complete" | "totp/confirm", body: unknown) {
  const response = await fetch(`/api/bff/auth/${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json", "X-Requested-With": "post-history-web" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as { code?: string; totp_enrollment?: Enrollment } };
}

/**
 * قبول الدعوة (S5) ورابطها غير الصالح (S5b) على وجه المتجر الداكن. خطوتان ظاهرتان في رأس البطاقة: كلمة المرور (12 حرفًا فأكثر وتأكيدها)، ثم ربط
 * تطبيق المصادقة (TOTP) وهو إلزامي. الرمز من جزء الرابط بعد `#` ويُمحى من شريط العنوان، أو يُلصق في حقله؛ ولا يُحفظ في أي تخزين.
 * اسم المؤسسة والدور والبريد لا تُعرض: قراءة الدعوة برمزها ليست في العقد (فجوة، ADR 0103)، فالصفحة «عيّن كلمة المرور» وحدها.
 * `kind="reset"` صفحة إعادة التعيين (ADR 0107، 0108) بالخطوتين نفسيهما ونقطتيهما: رابط مدير النظام أو المشرف رمزٌ كرمز الدعوة، على الوجه
 * الفاتح، وبعدها إلى الوارد (والمشتري يُحال منه إلى المتجر).
 */
export function InviteAccept({ locale, kind = "invite" }: { locale: Locale; kind?: "invite" | "reset" }) {
  const m = messages[locale], t: typeof m.store.invite = kind === "reset" ? m.recovery.reset : m.store.invite, other = locale === "ar" ? "en" : "ar", reset = kind === "reset";
  const fromLink = useSyncExternalStore(still, linkToken, () => null), [typed, setTyped] = useState(""), [spent, setSpent] = useState(false);
  const linked = !!fromLink && !spent, token = linked ? fromLink! : typed, setToken = (value: string) => { setTyped(value); if (!value) setSpent(true); };
  const [step, setStep] = useState<Step>("password"), [password, setPassword] = useState(""), [repeat, setRepeat] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null), [code, setCode] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [checked, setChecked] = useState(false);
  // الرمز وبيانات الربط في ذاكرة الصفحة وحدها؛ تُنسى عند المغادرة.
  useEffect(() => () => { captured = undefined; }, []);
  const tokenOk = validToken(cleanToken(token)), passwordOk = validPassword(password), same = password === repeat;
  async function setPasswordStep(event: React.FormEvent) {
    event.preventDefault(); setChecked(true); setError(null);
    if (!tokenOk || !passwordOk || !same) return;
    setBusy(true);
    try {
      const result = await post("recovery/complete", { reset_token: cleanToken(token), new_password: password });
      if (result.status === 401) { setToken(""); setPassword(""); setRepeat(""); setStep("invalid"); return; }
      if (result.status === 429) { setError(t.tooMany); return; }
      if (result.status !== 200 || !result.body.totp_enrollment) { setError(result.status === 422 ? t.invalidInput : m.error); return; }
      setEnrollment(result.body.totp_enrollment); setToken(""); setPassword(""); setRepeat(""); setChecked(false); setStep("totp");
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  async function confirm(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    if (!/^[0-9]{6}$/.test(code)) { setError(t.codeInvalid); return; }
    setBusy(true);
    try {
      const result = await post("totp/confirm", { totp_code: code });
      if (result.status === 200) {
        setEnrollment(null);
        if ("BroadcastChannel" in window) { const channel = new BroadcastChannel("web-session"); channel.postMessage("signed-in"); channel.close(); }
        window.location.replace(`/${locale}/${reset ? "inbox" : "store"}`); return;
      }
      setCode("");
      if (result.status === 401 && result.body.code === "session_revoked") { setEnrollment(null); setStep("expired"); return; }
      setError(result.status === 401 ? t.codeWrong : result.status === 429 ? t.tooMany : m.error);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  const lost = step === "invalid" || step === "expired";
  return <PublicFrame locale={locale} switchHref={`/${other}/${reset ? "reset-password" : "invite"}`} label={`${m.brand} · ${m.product}`} mode={reset ? undefined : "dark"}>
    <main className="public-main invite-main" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
      <section className="card invite-card" aria-labelledby="invite-title" data-testid={kind} data-step={step}>
        {lost ? <div className="verify-missing" data-testid={`${kind}-invalid`}>
          <span className="empty-icon warn"><Icon name="alert" size={22} /></span>
          <h1 id="invite-title">{step === "invalid" ? t.invalidTitle : t.expiredTitle}</h1>
          <p className="muted">{step === "invalid" ? t.invalidBody : t.expiredBody}</p>
          <Link prefetch={false} className="button secondary" href={`/${locale}/login`}>{t.signIn}</Link>
        </div> : <>
          <p className="invite-badge"><Icon name={reset ? "key" : "store"} size={14} />{t.badge}</p>
          <h1 id="invite-title">{step === "password" ? t.title : t.totpTitle}</h1>
          <p className="muted">{step === "password" ? t.lead : t.totpLead}</p>
          <ol className="invite-steps" aria-label={t.stepsLabel}>{(["password", "totp"] as const).map(which => <li key={which} aria-current={step === which ? "step" : undefined} className={step === which ? "active" : step === "totp" && which === "password" ? "done" : undefined}>{which === "password" ? t.stepPassword : t.stepTotp}</li>)}</ol>
          {step === "password" ? <form className="invite-form" noValidate onSubmit={e => void setPasswordStep(e)}>
            {!linked && <label>{t.token}<input name="token" dir="ltr" autoComplete="off" spellCheck={false} value={token} maxLength={300} aria-invalid={checked && !tokenOk || undefined} aria-describedby="invite-token-help" onChange={e => setToken(e.target.value)} /><small id="invite-token-help" className="field-help">{checked && !tokenOk ? t.tokenInvalid : t.tokenHelp}</small></label>}
            <label>{t.newPassword}<input name="new-password" type="password" dir="ltr" autoComplete="new-password" minLength={passwordMin} maxLength={256} value={password} aria-invalid={checked && !passwordOk || undefined} aria-describedby="invite-password-help" onChange={e => setPassword(e.target.value)} /></label>
            <small id="invite-password-help" className="field-help">{checked && !passwordOk ? t.passwordShort : t.passwordHint}</small>
            <label>{t.repeatPassword}<input name="repeat-password" type="password" dir="ltr" autoComplete="new-password" maxLength={256} value={repeat} aria-invalid={checked && !same || undefined} onChange={e => setRepeat(e.target.value)} /></label>
            {checked && !same && <small className="field-error" role="alert">{t.mismatch}</small>}
            {error && <p className="notice error" role="alert">{error}</p>}
            <button className={reset ? "full-width" : "store full-width"} disabled={busy}>{busy ? m.review.saving : t.submit}</button>
            <p className="caption">{t.next}</p>
          </form> : enrollment && <form className="invite-form" noValidate onSubmit={e => void confirm(e)}>
            <div className="totp-secret"><span className="caption">{t.secret}</span><output className="mono" dir="ltr" data-testid="totp-secret">{groupSecret(enrollment.secret_base32)}</output>
              <a className="button secondary" href={enrollment.otpauth_uri}>{t.openApp}</a></div>
            <p className="caption">{t.secretOnce}</p>
            <label>{t.code}<input name="totp" inputMode="numeric" dir="ltr" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></label>
            {error && <p className="notice error" role="alert">{error}</p>}
            <button className={reset ? "full-width" : "store full-width"} disabled={busy}>{busy ? m.review.saving : t.confirm}</button>
          </form>}
          {step === "password" && <p className="invite-ignore caption">{t.ignore}</p>}
        </>}
      </section>
    </main>
  </PublicFrame>;
}
