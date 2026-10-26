import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { formatDuration, formatMoney, localized, type LicenseType, type Localized, type Price } from "@/lib/store-format";
import type { Material } from "@/lib/types";

// بطاقة مادة في الكتالوج (D1): حقول CatalogItem العامة وحدها.
// شرط الأمن على #205: يوم التصوير وحده بلا ساعة حتى لو وصلت قيمة بوقت، والنسب باسم الظهور وحده (اسم الشبكة أو الاسم
// المعتمد للنشر في `credit`)، لا الاسم الحقيقي ولا معرّف المراسل؛ لا خاصية هنا تقبل غيرهما، ولا بصمة ولا معرّف تقني.
export type CatalogCardProps = { href: string; title: Localized; governorate: string; shotOn: string | null; durationMs: number | null; width: number | null; height: number | null; displayName: string; from: Price | null; thumbnail?: string; types?: Material["material_types"]; licenses?: LicenseType[]; exclusive?: boolean };
export const shotDay = (value: string | null) => (value ? /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null : null);
export const resolution = (width: number | null, height: number | null) => width && height ? `${width}×${height}` : null;
export function CatalogCard({ locale, item }: { locale: Locale; item: CatalogCardProps }) {
  const m = messages[locale], s = m.store, duration = formatDuration(item.durationMs), day = shotDay(item.shotOn);
  return <article className="catalog-card" data-testid="catalog-card">
    {/* المصغّرة من مسار BFF الخاص؛ محسّن الصور في Next يخزّنها، فلا يُستعمل next/image. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <Link prefetch={false} href={item.href} className="catalog-thumb" tabIndex={-1} aria-hidden="true">{item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <span />}<span className="thumb-mark" dir="ltr">{messages.en.brand}</span>
      <span className="badge good thumb-verified">{s.browse.verified}</span>{item.exclusive && <span className="badge rights thumb-exclusive">{s.browse.exclusive}</span>}{duration && <small dir="ltr">{duration}</small>}</Link>
    <div className="catalog-body">
      {item.types?.length ? <p className="overline">{item.types.map(t => m.types[t]).join(" · ")}</p> : null}
      <h3><Link prefetch={false} href={item.href}>{localized(item.title, locale)}</Link></h3>
      <p className="muted">{[item.governorate, day && new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)), resolution(item.width, item.height)].filter(Boolean).join(" · ")}</p>
      {item.displayName && <p className="caption">{s.credit}: {item.displayName}</p>}
      <p className="price">{item.from ? <>{s.from} <strong dir="ltr">{formatMoney(item.from, locale)}</strong></> : s.unavailable}</p>
      {item.licenses?.length ? <p className="caption">{item.licenses.map(l => s.licenseTypes[l]).join(" · ")}</p> : null}
    </div>
  </article>;
}
