"use client";
import { useState } from "react";
import Link from "next/link";
import { publicPost } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";
import { normalizeBackupCode, recoveryLimits } from "@/lib/recovery-policy";
import { PublicFrame } from "./public-frame";
import { Icon } from "./icon";

const validEmail = (value: string) => value.length <= recoveryLimits.email && /^[^\s@]+@[^\s@]+$/.test(value);

/**
 * «نسيت كلمة المرور» من P1 (ADR 0107، 0108): لا بريد يُرسل في هذه المرحلة، فالحساب يعود برابط إعادة تعيين يسلّمه شخص يعرف صاحبه. طريقان:
 * رمز احتياطي يفتح طلب استعادة يعتمده المشرف (`POST /auth/recovery`، والرد واحد لأي بريد ورمز فلا تُكشف صحتهما)، أو التواصل مع مدير النظام
 * ليصدر رابطًا من A1. البريد والرمز في ذاكرة الصفحة وحدها ويُمحيان بعد الإرسال.
 */
export function ForgotPassword({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.recovery.forgot, other = locale === "ar" ? "en" : "ar";
  const [email, setEmail] = useState(""), [code, setCode] = useState(""), [checked, setChecked] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null), [sent, setSent] = useState(false);
  const address = email.trim(), emailOk = validEmail(address), normalized = normalizeBackupCode(code);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setChecked(true); setError(null);
    if (!emailOk || !normalized) return;
    setBusy(true);
    try {
      const result = await publicPost("auth/recovery", { email: address, backup_code: normalized });
      if (result.status === 202) { setEmail(""); setCode(""); setChecked(false); setSent(true); return; }
      setError(result.status === 429 ? t.tooMany : result.status === 422 ? t.codeInvalid : m.error);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  return <PublicFrame locale={locale} switchHref={`/${other}/forgot-password`} label={`${m.brand} · ${m.product}`}>
    <main className="public-main" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
      <section className="card recovery-card" aria-labelledby="forgot-title" data-testid="forgot">
        <h1 id="forgot-title">{t.title}</h1>
        <p className="muted">{t.lead}</p>
        <div className="recovery-paths">
          <section className="recovery-path" aria-labelledby="forgot-code-title" data-testid="forgot-code">
            <h2 id="forgot-code-title"><Icon name="key" />{t.codeTitle}</h2>
            <p className="muted">{t.codeLead}</p>
            {sent ? <div className="notice good" role="status" data-testid="forgot-sent"><strong>{t.sentTitle}</strong><p>{t.sentBody}</p></div>
              : <form className="invite-form" noValidate onSubmit={event => void submit(event)}>
                <label>{t.email}<input name="email" type="email" dir="ltr" autoComplete="username" maxLength={recoveryLimits.email} value={email} aria-invalid={checked && !emailOk || undefined} onChange={event => setEmail(event.target.value)} /></label>
                <label>{t.code}<input name="backup-code" dir="ltr" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={recoveryLimits.code} value={code} aria-invalid={checked && !normalized || undefined} aria-describedby="forgot-code-help" onChange={event => setCode(event.target.value)} /></label>
                <small id="forgot-code-help" className="field-help">{checked && !normalized ? t.codeInvalid : t.codeHelp}</small>
                {error && <p className="notice error" role="alert">{error}</p>}
                <button className="full-width" disabled={busy}>{busy ? m.review.saving : t.submit}</button>
              </form>}
          </section>
          <section className="recovery-path" aria-labelledby="forgot-admin-title" data-testid="forgot-admin">
            <h2 id="forgot-admin-title"><Icon name="users" />{t.adminTitle}</h2>
            <p className="muted">{t.adminLead}</p>
            <p className="caption">{t.adminNote}</p>
          </section>
        </div>
        <Link prefetch={false} className="button secondary" href={`/${locale}/login`}>{t.back}</Link>
      </section>
    </main>
  </PublicFrame>;
}
