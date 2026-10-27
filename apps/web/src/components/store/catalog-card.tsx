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
/** مسرد الرخص للبطاقة (Figma 169:183): «تحريري، حصرية متاحة، تجاري»؛ الحصرية من `exclusive_available` وحده لا من وجود عرض حصري. */
export function licenseFamilies(licenses: LicenseType[], exclusive: boolean, locale: Locale) {
  const s = messages[locale].store, families: string[] = [];
  if (licenses.some(l => l === "editorial_single" || l === "editorial_term")) families.push(s.browse.family.editorial);
  if (exclusive && licenses.includes("exclusive_temporary")) families.push(s.browse.exclusive);
  if (licenses.includes("commercial")) families.push(s.licenseTypes.commercial);
  return families;
}
/** مثلث التشغيل (Figma Icon/play 23:20): خطّي على شبكة 24، زخرفي. */
function IconPlay() { return <svg className="thumb-play" width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M7 4L20 12L7 20V4Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
export function CatalogCard({ locale, item }: { locale: Locale; item: CatalogCardProps }) {
  const m = messages[locale], s = m.store, duration = formatDuration(item.durationMs), day = shotDay(item.shotOn), families = licenseFamilies(item.licenses ?? [], !!item.exclusive, locale);
  return <article className="catalog-card" data-testid="catalog-card">
    {/* المصغّرة من مسار BFF الخاص؛ محسّن الصور في Next يخزّنها، فلا يُستعمل next/image. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <Link prefetch={false} href={item.href} className="catalog-thumb" tabIndex={-1} aria-hidden="true">{item.thumbnail ? <img src={item.thumbnail} alt="" loading="lazy" /> : <span />}<span className="thumb-mark" dir="ltr">{messages.en.brand}</span><IconPlay />
      <span className="badge good thumb-verified">{s.browse.verified}</span>{duration && <small dir="ltr">{duration}</small>}</Link>
    <div className="catalog-body">
      <h3><Link prefetch={false} href={item.href}>{localized(item.title, locale)}</Link></h3>
      <p className="catalog-meta">{item.types?.length ? <span>{item.types.map(t => m.types[t]).join(locale === "ar" ? "، " : ", ")}</span> : null}{item.governorate && <span>{item.governorate}</span>}{day && <span>{new Intl.DateTimeFormat(locale === "ar" ? "ar-PS-u-nu-latn" : locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`))}</span>}</p>
      {(item.displayName || resolution(item.width, item.height)) && <p className="caption catalog-credit">{item.displayName && <span>{s.credit}: {item.displayName}</span>}{resolution(item.width, item.height) && <span dir="ltr">{resolution(item.width, item.height)}</span>}</p>}
      <p className="catalog-price"><span className="price">{item.from ? <>{s.browse.startsAt} <strong dir="ltr">{formatMoney(item.from, locale)}</strong></> : s.unavailable}</span>{families.length > 0 && <span className="families">{families.join(locale === "ar" ? "، " : ", ")}</span>}</p>
    </div>
  </article>;
}
