"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { authPost, browserApi, publicPost } from "@/lib/browser-api";
import { ceremonyFailure, passkeysSupported, signInCeremony } from "@/lib/passkey-client";
import type { PasskeyChallenge } from "@/lib/passkey-policy";
import { clearUploads } from "@/lib/upload-store";
import { messages, type Locale } from "@/lib/i18n";
import { homePage, type HomePage } from "@/lib/home-page";
import { clearCart } from "./store/cart";
import { BrandMark, Icon } from "./icon";

const still = () => () => {};
/** بعد الدخول: صفحة يقرؤها الدور (المالية في الصرف، المشتري في المتجر)، لا الوارد لكل أحد. تعذّر القراءة يعيد إلى الوارد كما كان. */
const signedIn = async (locale: Locale) => {
  if ("BroadcastChannel" in window) { const channel = new BroadcastChannel("web-session"); channel.postMessage("signed-in"); channel.close(); }
  let page: HomePage = "inbox";
  try { const result = await browserApi().GET("/auth/me"); if (result.response.ok && result.data) page = homePage(result.data); } catch { /* الوارد */ }
  window.location.replace(`/${locale}/${page}`);
};

export function Login({ locale, reason }: { locale: Locale; reason?: string }) {
  const m = messages[locale]; const [busy, setBusy] = useState(false), [error, setError] = useState(""), [passkeyBusy, setPasskeyBusy] = useState(false);
  // دعم WebAuthn يُعرف في المتصفح وحده؛ لقطة الخادم «غير مدعوم» فلا يُرسم زرّ لا يعمل قبل التحميل.
  const supported = useSyncExternalStore(still, passkeysSupported, () => false);
  // صفحة الدخول تعني لا جلسة: لا يبقى من رفعات مستخدم سابق على هذا الحاسوب شيء (S10).
  useEffect(() => { clearUploads(); clearCart(); }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, fields = new FormData(form);
    setBusy(true); setError("");
    try {
      const result = await authPost("login", { email: fields.get("email"), password: fields.get("password"), ...(fields.get("totp") ? { totp_code: fields.get("totp") } : {}) });
      if (!result.response.ok) { setError(result.body.code === "totp_required" ? m.totpRequired : m.loginFailed); return; }
      form.reset(); await signedIn(locale);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  const t = m.signInPage;
  /** الدخول بمفتاح المرور (ADR 0108): التحدي من الخادم، ثم مراسم المتصفح، ثم التحقق في الخادم وجلسة جديدة. لا بريد يُكتب: المفتاح يعرّف صاحبه. */
  async function passkey() {
    setError("");
    if (!passkeysSupported()) { setError(t.passkeyUnsupported); return; }
    setPasskeyBusy(true);
    try {
      const options = await publicPost<PasskeyChallenge>("auth/passkeys/login-options", {});
      if (options.status === 404) { setError(t.passkeyUnavailable); return; }
      if (options.status !== 200 || !options.body.challenge_id || !options.body.public_key) { setError(m.error); return; }
      let credential;
      try { credential = await signInCeremony(options.body as PasskeyChallenge); }
      catch (failure) { setError(ceremonyFailure(failure) === "cancelled" ? t.passkeyCancelled : t.passkeyFailed); return; }
      const result = await publicPost("auth/passkeys/login", { challenge_id: options.body.challenge_id, credential });
      if (result.status === 200) { await signedIn(locale); return; }
      setError(result.status === 410 ? t.passkeyExpired : result.status === 404 ? t.passkeyUnavailable : result.status === 401 ? t.passkeyFailed : m.error);
    } catch { setError(m.error); } finally { setPasskeyBusy(false); }
  }
  // P1: لوحة الهوية الداكنة في جهة البداية ونصف للنموذج (وضع داكن صريح، ودوائر البثّ). المراسل يُحال إلى تطبيق «ميدان بوست». مفتاح المرور
  // والاستعادة بلا بريد (ADR 0107، 0108): زرّ المفتاح حيث يدعمه المتصفح، و«نسيت كلمة المرور» تشرح الطريقين.
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
          <button className="full-width" disabled={busy || passkeyBusy}>{busy ? m.signingIn : m.signIn}</button>
        </form>
        <Link prefetch={false} className="login-forgot" href={`/${locale}/forgot-password`} data-testid="forgot-link">{t.forgot}</Link>
        {supported && <>
          <p className="login-or" aria-hidden="true"><span>{t.or}</span></p>
          <button type="button" className="secondary full-width login-passkey" data-testid="passkey-sign-in" disabled={busy || passkeyBusy} onClick={() => void passkey()}><Icon name="key" />{passkeyBusy ? t.passkeyBusy : t.passkey}</button>
        </>}
        <p className="login-session"><Icon name="shield" size={16} /><span>{t.session}</span></p>
      </div>
    </section>
  </main>;
}
