import Link from "next/link";
import { messages, type Locale } from "@/lib/i18n";
import { formatDuration, localized, longDay, type Localized } from "@/lib/store-format";
import { Icon } from "../icon";
import { governorateName } from "@/lib/format";

// بطاقة المادة في المتجر (`Web/Store card`، S1 وM4): غلاف داكن عليه «معاينة · علامة مائية» دائمًا، والعنوان، و«صُوّر» بيوم التصوير
// والمحافظة وحدها، وفعل واحد إلى صفحة المادة. لا اسم مراسل ولا نسب ولا مصدر (web-v2.md S1)، ولا بصمة ولا معرّف تقني؛ فلا خاصية
// هنا تقبل غير ذلك. يوم التصوير يوم بلا ساعة حتى لو وصلت قيمة بوقت (شرط الأمن على #205).
export type CatalogCardProps = { href: string; title: Localized; governorate: string; shotOn: string | null; durationMs: number | null; exclusive?: boolean };
export const shotDay = (value: string | null) => (value ? /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null : null);
export const resolution = (width: number | null, height: number | null) => width && height ? `${width}×${height}` : null;

export function CatalogCard({ locale, item }: { locale: Locale; item: CatalogCardProps }) {
  const m = messages[locale], s = m.store, c = s.card, duration = formatDuration(item.durationMs), day = longDay(shotDay(item.shotOn), locale), title = localized(item.title, locale);
  const meta = [day ? c.shot.replace("{date}", day) : null, item.governorate ? governorateName(item.governorate, m.governorates) : null].filter(Boolean).join(s.catalog.listSeparator);
  return <article className="store-card" data-testid="catalog-card">
    {/* الغلاف زخرفي ومكرّر للرابط؛ لا مصغّرة من الأصل: المعاينة بعلامتها في صفحة المادة وحدها. */}
    <Link prefetch={false} href={item.href} className="store-card-cover" tabIndex={-1} aria-hidden="true">
      <span className="store-card-badge">{c.previewBadge}</span>
      {item.exclusive && <span className="store-card-exclusive">{s.browse.exclusive}</span>}
      <span className="store-card-play"><Icon name="play" size={20} /></span>
      {duration && <span className="store-card-duration" dir="ltr">{duration}</span>}
    </Link>
    <div className="store-card-body">
      <h3><Link prefetch={false} href={item.href}>{title}</Link></h3>
      {meta && <p className="store-card-meta">{meta}</p>}
      <Link prefetch={false} href={item.href} className="button store store-card-cta" aria-label={c.ctaFor.replace("{title}", title)}>{c.cta}</Link>
    </div>
  </article>;
}
