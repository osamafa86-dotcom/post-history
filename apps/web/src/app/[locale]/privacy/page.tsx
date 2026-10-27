import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale, messages } from "@/lib/i18n";
import { privacyContactEmail } from "@/server/privacy-contact";

// البريد يُقرأ من بيئة الخادم عند كل طلب (لا تجميد وقت البناء، ولا NEXT_PUBLIC).
export const dynamic = "force-dynamic";

const EMAIL_TOKEN = "{email}";

// يستبدل رمز {email} بالعقدة المعطاة؛ النص والبريد كلاهما يمرّان من هروب React.
function withEmail(text: string, email: ReactNode): ReactNode[] {
  return text.split(EMAIL_TOKEN).flatMap((part, index) => index === 0 ? [part] : [<Fragment key={index}>{email}</Fragment>, part]);
}

export default async function PrivacyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const m = messages[locale].privacy;
  const address = privacyContactEmail();
  const email = address ? <a href={`mailto:${address}`} dir="ltr">{address}</a> : m.emailPending;
  return <main dir={locale === "ar" ? "rtl" : "ltr"} lang={locale} className="mx-auto max-w-3xl px-6 py-12">
    <h1 className="mb-6 text-3xl font-bold">{m.title}</h1>
    {!address && <p role="note" className="mb-6 rounded border p-4 font-semibold">{m.temporary}</p>}
    <p className="mb-8 leading-8">{m.body}</p>
    {m.sections.map((section, index) => <section key={section.heading} aria-labelledby={`privacy-section-${index + 1}`} className="mb-8">
      <h2 id={`privacy-section-${index + 1}`} className="mb-3 text-xl font-bold">{section.heading}</h2>
      {section.paragraphs.map((paragraph) => <p key={paragraph} className="mb-3 leading-8">{withEmail(paragraph, email)}</p>)}
    </section>)}
    <nav aria-label={m.languageNavigation}>
      <Link href={`/${locale === "ar" ? "en" : "ar"}/privacy`} hrefLang={locale === "ar" ? "en" : "ar"} lang={locale === "ar" ? "en" : "ar"}>{m.otherLanguage}</Link>
    </nav>
  </main>;
}
