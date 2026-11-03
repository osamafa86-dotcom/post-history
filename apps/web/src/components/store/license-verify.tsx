"use client";
import { useEffect, useState } from "react";
import { longDate, messages, type Locale } from "@/lib/i18n";
import { licenseNumberPattern, type PublicVerification } from "@/lib/issued-licenses";
import { PublicFrame } from "../public-frame";
import { Icon, type IconName } from "../icon";

export const licenseTone = (status: PublicVerification["status"]) => status === "active" ? "good" : status === "revoked" ? "bad" : "";
/** كلمة الحالة بأيقونة ونغمة (لا لون وحده): الساري ok، والمنتهي warn، والمُبطل danger. */
export const verifyWord = (status: PublicVerification["status"]): { tone: "ok" | "warn" | "danger"; icon: IconName } =>
  status === "active" ? { tone: "ok", icon: "check" } : status === "expired" ? { tone: "warn", icon: "clock" } : { tone: "danger", icon: "ban" };

/**
 * التحقّق من ترخيص (P2) وترخيص غير موجود (P3) بإطار الصفحات العامة: بطاقة واحدة متوسّطة بالحقول الثلاثة التي يغلق عليها العقد (الرقم والحالة
 * والنهاية) وسطر يقول ما لا تعرضه. لا مادة ولا نوع ترخيص ولا مؤسسة ولا سعر ولا مراسل. `404` يقول السبب المحتمل، و`429` يقول إن الصفحة
 * محدودة المعدل حمايةً للأرقام من التعداد. رقم بغير صيغة العقد لا يُرسل إلى الخادم.
 */
export function LicenseVerify({ locale, number }: { locale: Locale; number: string }) {
  const m = messages[locale], t = m.licenses, v = t.verify, valid = licenseNumberPattern.test(number), other = locale === "ar" ? "en" : "ar";
  const [result, setResult] = useState<PublicVerification | null>(null), [status, setStatus] = useState(valid ? 0 : 404);
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    void fetch(`/api/bff/license-verifications/${encodeURIComponent(number)}`, { cache: "no-store", credentials: "omit", signal: controller.signal })
      .then(async response => { if (!response.ok) { setStatus(response.status); return; } setResult(await response.json() as PublicVerification); })
      .catch(() => { if (!controller.signal.aborted) setStatus(503); });
    return () => controller.abort();
  }, [number, valid]);
  const word = result ? verifyWord(result.status) : null;
  return <PublicFrame locale={locale} switchHref={`/${other}/verify/${encodeURIComponent(number)}`}>
    <main className="public-main verify-main" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
      <section className="card verify-card" aria-labelledby="verify-title" data-testid="verification" data-state={status ? "missing" : result ? "found" : "loading"}>
        {status ? <div className="verify-missing">
          <span className={`empty-icon ${status === 404 ? "warn" : ""}`}><Icon name={status === 429 ? "clock" : "alert"} size={22} /></span>
          <h1 id="verify-title">{status === 404 ? v.notFound : status === 429 ? v.tooMany : v.unavailable}</h1>
          <p className="muted">{status === 404 ? v.notFoundBody : status === 429 ? v.tooManyBody : v.unavailableBody}</p>
          {status === 404 && valid && <p className="mono verify-number" dir="ltr">{number}</p>}
        </div> : <>
          <div className="verify-head"><span className={`verify-seal ${word?.tone ?? ""}`}><Icon name={word?.icon ?? "license"} size={22} /></span>
            <div><h1 id="verify-title">{v.title}</h1><p className="muted">{result ? v.lead : m.loading}</p></div></div>
          {!result ? <p className="visually-hidden" role="status">{m.loading}</p> : <dl className="verify-fields">
            <div><dt>{v.number}</dt><dd className="mono" dir="ltr">{result.license_number}</dd></div>
            <div><dt>{v.status}</dt><dd><span className={`badge state ${word!.tone}`} data-testid="verification-status"><Icon name={word!.icon} size={14} />{t.statuses[result.status]}</span></dd></div>
            <div><dt>{v.ends}</dt><dd className="ref">{result.valid_until ? longDate(result.valid_until, locale) : v.noExpiry}</dd></div>
          </dl>}
          <p className="verify-scope"><Icon name="shield" size={16} /><span>{v.scope}</span></p>
        </>}
      </section>
    </main>
  </PublicFrame>;
}
