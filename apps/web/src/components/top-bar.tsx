import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import type { NavItem } from "./workspace-nav";

/**
 * الشريط العلوي الداكن المشترك (Figma 193:593 وَ185:333 وَ193:865، قرار المالك 2026-10-27): الشعار في بداية السطر، البنود بخط سفلي للنشط،
 * والمستخدم (أو الساعة على لوحة الشاشة الكبيرة) في النهاية. `header` يحمل `nav` بتسمية، والنشط `aria-current="page"`.
 * الاتجاه من `dir` الصفحة وخصائص CSS المنطقية، فينعكس في LTR دون شيفرة.
 */
export function TopBar({ locale, brandHref, items, navLabel, variant, children }: { locale: Locale; brandHref: string; items: NavItem[]; navLabel: string; variant: "workspace" | "wall"; children: React.ReactNode }) {
  const m = messages[locale];
  return <header className={`topbar ${variant}`} data-testid="topbar">
    <Link className="topbar-brand" href={brandHref} prefetch={false}><span className="brand-mark" aria-hidden="true" /><span>{m.product}</span></Link>
    <nav className="topbar-nav" aria-label={navLabel}>{items.map(item => <Link key={item.key} prefetch={false} href={item.href} aria-current={item.active ? "page" : undefined}>{item.label}</Link>)}</nav>
    <div className="topbar-end">{children}</div>
  </header>;
}
