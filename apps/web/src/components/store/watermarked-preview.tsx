"use client";
import { messages, type Locale } from "@/lib/i18n";

// معاينة المتجر: المصدر رابط موقّع قصير العمر بعلامة مائية مدمجة من العامل؛ الطبقة هنا تحمل هوية المشاهد فوقها.
// لا زر تنزيل ولا صورة داخل صورة؛ إخفاء التنزيل ليس حماية، والحماية في الرابط والعلامة المدمجة.
export function WatermarkedPreview({ locale, src, poster, viewer }: { locale: Locale; src: string | null; poster?: string; viewer: string }) {
  const s = messages[locale].store;
  if (!src) return <div className="store-preview empty" role="status">{s.previewUnavailable}</div>;
  return <figure className="store-preview" onContextMenu={e => e.preventDefault()}>
    <video src={src} poster={poster} controls playsInline preload="metadata" controlsList="nodownload noplaybackrate" disablePictureInPicture aria-label={s.preview} />
    <figcaption className="viewer-mark" aria-hidden="true" dir="ltr">{viewer}</figcaption>
  </figure>;
}
