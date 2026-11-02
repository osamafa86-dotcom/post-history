"use client";
import { useEffect, useState } from "react";
import { authPost } from "@/lib/browser-api";
import { clearUploads } from "@/lib/upload-store";
import { messages, type Locale } from "@/lib/i18n";
import { BrandMark, Icon } from "./icon";

export function Login({ locale, reason }: { locale: Locale; reason?: string }) {
  const m = messages[locale]; const [busy, setBusy] = useState(false), [error, setError] = useState("");
  // صفحة الدخول تعني لا جلسة: لا يبقى من رفعات مستخدم سابق على هذا الحاسوب شيء (S10).
  useEffect(() => { clearUploads(); }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
    setBusy(true); setError("");
    try {
      const result = await authPost("login", { email: fields.get("email"), password: fields.get("password"), ...(fields.get("totp") ? { totp_code: fields.get("totp") } : {}) });
      if (!result.response.ok) { setError(result.body.code === "totp_required" ? m.totpRequired : m.loginFailed); return; }
      form.reset();
      if ("BroadcastChannel" in window) { const channel = new BroadcastChannel("web-session"); channel.postMessage("signed-in"); channel.close(); }
      window.location.replace(`/${locale}/inbox`);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  const t = m.signInPage;
  // P1: لوحة الهوية الداكنة في جهة البداية ونصف للنموذج (وضع داكن صريح، ودوائر البثّ). المراسل يُحال إلى تطبيق «ميدان بوست»، ولا مفتاح مرور ولا استعادة من الويب (ليسا في العقد).
  return <main className="login-shell">
    <section className="login-story" data-mode="dark" aria-labelledby="story-title">
      <span className="rings" aria-hidden="true"><span /><span /><span /></span>
      <div><h2 id="story-title">{t.storyTitle}</h2><p>{t.storyLead}</p></div>
    </section>
    <section className="login-panel">
      <a className="locale-link" href={`/${locale === "ar" ? "en" : "ar"}/login`} lang={locale === "ar" ? "en" : "ar"}>{m.language}</a>
      <div className="login-card">
        <p className="login-brand"><BrandMark size={28} /><span>{m.product}</span></p>
        <h1>{t.welcome}</h1>
        <p className="login-lead">{t.lead}</p>
        <p className="login-reporters"><Icon name="mine" /><span>{t.reporters}</span></p>
        {reason === "revoked" && <p className="notice" role="status">{m.revoked}</p>}{reason === "signed-out" && <p className="notice">{m.signedOut}</p>}
        <form onSubmit={submit}>
          <label>{m.email}<input name="email" type="email" dir="ltr" autoComplete="username" maxLength={254} required /></label>
          <label>{m.password}<input name="password" type="password" dir="ltr" autoComplete="current-password" minLength={8} maxLength={1024} required /></label>
          <label>{m.totp}<input name="totp" inputMode="numeric" dir="ltr" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} aria-describedby="totp-help" /></label>
          <small id="totp-help" className="field-help">{m.totpHelp}</small>
          {error && <p className="notice error" role="alert">{error}</p>}
          <button className="full-width" disabled={busy}>{busy ? m.signingIn : m.signIn}</button>
        </form>
        <p className="login-session"><Icon name="shield" size={16} /><span>{t.session}</span></p>
      </div>
    </section>
  </main>;
}
