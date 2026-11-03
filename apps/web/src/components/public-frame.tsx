import { messages, type Locale } from "@/lib/i18n";
import { BrandMark } from "./icon";

/**
 * إطار الصفحات العامة بلا جلسة (P2 وP3 والخصوصية وS5): العلامة في جهة البداية، ورابط اللغة الأخرى في الطرف الآخر، ثم المحتوى. لا شريط جانبي ولا
 * بحث ولا حساب. `mode="dark"` لوجه المتجر الداكن (S5، إطار `s5-store-invite`)، وإلا فاتح كإطارات P.
 */
export function PublicFrame({ locale, switchHref, switchLabel, label, mode, children }: { locale: Locale; switchHref: string; switchLabel?: string; label?: string; mode?: "dark"; children: React.ReactNode }) {
  const m = messages[locale], other = locale === "ar" ? "en" : "ar";
  return <div className={`public-shell${mode === "dark" ? " store-face" : ""}`} data-mode={mode} dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
    <header className="public-head">
      <span className="public-brand"><BrandMark size={28} /><span>{label ?? m.brand}</span></span>
      <nav aria-label={m.publicPage.languageNav}><a className="public-locale" href={switchHref} hrefLang={other} lang={other}>{switchLabel ?? m.language}</a></nav>
    </header>
    {children}
  </div>;
}
