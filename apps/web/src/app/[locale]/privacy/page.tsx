import { Fragment, type ReactNode } from "react";
import { notFound } from "next/navigation";
import { isLocale, messages } from "@/lib/i18n";
import { privacyContactEmail } from "@/server/privacy-contact";
import { PublicFrame } from "@/components/public-frame";
import { Icon } from "@/components/icon";

// البريد يُقرأ من بيئة الخادم عند كل طلب (لا تجميد وقت البناء، ولا NEXT_PUBLIC).
export const dynamic = "force-dynamic";

const EMAIL_TOKEN = "{email}";

// يستبدل رمز {email} بالعقدة المعطاة؛ النص والبريد كلاهما يمرّان من هروب React.
function withEmail(text: string, email: ReactNode): ReactNode[] {
  return text.split(EMAIL_TOKEN).flatMap((part, index) => index === 0 ? [part] : [<Fragment key={index}>{email}</Fragment>, part]);
}

/** الخصوصية بإطار الصفحات العامة v2 (ADR 0103): فهرس الأقسام ثم الأقسام بطاقةً للقراءة. بريد التواصل من بيئة الخادم وحدها، ولا يُكتب في المستودع. */
export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = messages[locale].privacy, other = locale === "ar" ? "en" : "ar";
  const address = privacyContactEmail();
  const email = address ? <a href={`mailto:${address}`} dir="ltr">{address}</a> : m.emailPending;
  return <PublicFrame locale={locale} switchHref={`/${other}/privacy`} switchLabel={m.otherLanguage}>
    <main dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} className="public-main privacy-page">
      <div className="privacy-head"><h1>{m.title}</h1><p className="muted">{m.body}</p></div>
      {!address && <p role="note" className="notice attention privacy-pending"><Icon name="alert" size={16} /><span>{m.temporary}</span></p>}
      <div className="privacy-layout">
        <nav className="privacy-toc" aria-label={m.contents}><ol>{m.sections.map((section, index) => <li key={section.heading}><a href={`#privacy-section-${index + 1}`}>{section.heading}</a></li>)}</ol></nav>
        <div className="privacy-body">{m.sections.map((section, index) => <section key={section.heading} aria-labelledby={`privacy-section-${index + 1}`} className="privacy-section">
          <h2 id={`privacy-section-${index + 1}`}>{section.heading}</h2>
          {section.paragraphs.map((paragraph) => <p key={paragraph}>{withEmail(paragraph, email)}</p>)}
        </section>)}</div>
      </div>
    </main>
  </PublicFrame>;
}
