import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { formatDuration, formatMoney, localized, type Localized, type Price } from "@/lib/store-format";

// بطاقة مادة في الكتالوج: حقول CatalogItem العامة وحدها.
// شرط الأمن على #205: يوم التصوير وحده بلا ساعة حتى لو وصلت قيمة بوقت، والنسب باسم الظهور وحده (اسم الشبكة أو الاسم
// المعتمد للنشر في `credit`)، لا الاسم الحقيقي ولا معرّف المراسل؛ لا خاصية هنا تقبل غيرهما.
export type CatalogCardProps = { href: string; title: Localized; governorate: string; shotOn: string | null; durationMs: number | null; width: number | null; height: number | null; displayName: string; from: Price | null; thumbnail?: string };
export const shotDay = (value: string | null) => (value ? /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null : null);
export function CatalogCard({ locale, item }: { locale: Locale; item: CatalogCardProps }) {
  const s = messages[locale].store, duration = formatDuration(item.durationMs), day = shotDay(item.shotOn);
  return <article className="catalog-card" data-testid="catalog-card">
    {/* المصغّرة من مسار BFF الخاص؛ محسّن الصور في Next يخزّنها، فلا يُستعمل next/image. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <Link prefetch={false} href={item.href} className="catalog-thumb">{item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <span aria-hidden="true" />}{duration && <small dir="ltr">{duration}</small>}</Link>
    <div className="catalog-body">
      <h3><Link prefetch={false} href={item.href}>{localized(item.title, locale)}</Link></h3>
      <p className="muted">{[item.governorate, day && new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)), item.width && item.height ? `${item.width}×${item.height}` : null].filter(Boolean).join(" · ")}</p>
      {item.displayName && <p className="credit">{s.credit}: {item.displayName}</p>}
      <p className="price">{item.from ? <>{s.from} <strong dir="ltr">{formatMoney(item.from, locale)}</strong></> : s.unavailable}</p>
    </div>
  </article>;
}
