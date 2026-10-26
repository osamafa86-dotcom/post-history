"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { licenseNumberPattern, type PublicVerification } from "@/lib/issued-licenses";

export const licenseTone = (status: PublicVerification["status"]) => status === "active" ? "good" : status === "revoked" ? "bad" : "";

/** بطاقة واحدة متوسّطة: رقم الترخيص وحالته فقط (قرار الأمن على #383)؛ لا مؤسسة ولا مادة ولا شروط. */
export function LicenseVerify({ locale, number }: { locale: Locale; number: string }) {
  const m = messages[locale], t = m.licenses, v = t.verify, valid = licenseNumberPattern.test(number);
  const [result, setResult] = useState<PublicVerification | null>(null), [status, setStatus] = useState(valid ? 0 : 404);
  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    void fetch(`/api/bff/license-verifications/${encodeURIComponent(number)}`, { cache: "no-store", credentials: "omit", signal: controller.signal })
      .then(async response => { if (!response.ok) { setStatus(response.status); return; } setResult(await response.json() as PublicVerification); })
      .catch(() => { if (!controller.signal.aborted) setStatus(503); });
    return () => controller.abort();
  }, [number, valid]);
  return <main className="verify-page" dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
    <section className="card verify-card" aria-labelledby="verify-title" data-testid="verification">
      <p className="overline">{m.brand}</p><h1 id="verify-title">{v.title}</h1>
      {status ? <p role="alert">{status === 404 ? v.notFound : status === 429 ? v.tooMany : m.error}</p> : !result ? <p role="status">{m.loading}</p> : <>
        <p className="mono verify-number" dir="ltr">{result.license_number}</p>
        <p><span className={`badge ${licenseTone(result.status)}`} data-testid="verification-status">{t.statuses[result.status]}</span></p>
        <p className="caption">{v.scope}</p></>}
      <Link href={`/${locale === "ar" ? "en" : "ar"}/verify/${encodeURIComponent(number)}`} hrefLang={locale === "ar" ? "en" : "ar"} lang={locale === "ar" ? "en" : "ar"}>{m.language}</Link>
    </section>
  </main>;
}
