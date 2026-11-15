import type { Material, MaterialFile } from "./types";
import { uuid } from "./query";

/**
 * الملف الذي اشتق الخادم هذا الملف منه (`derived_from_id`)، أو `null` لملف مرفوع. الحقل يُقرأ بحذر: ما لم يصل من الخادم بمعرّف صحيح لا يُعدّ
 * مشتقًا (يُغلق ولا يُفتح).
 */
export function sourceOf(file: MaterialFile): string | null {
  const source = (file as MaterialFile & { derived_from_id?: unknown }).derived_from_id;
  return typeof source === "string" && uuid.test(source) ? source : null;
}
/**
 * ملف صنعه الخادم: مشتق من ملف آخر. النسخة الخفيفة التي يرفعها الهاتف ملف `proxy` أيضًا لكنه مرفوع لا مشتق، فقد يحمل ما لم يجرّده الخادم.
 */
export const serverMade = (file: MaterialFile): boolean => sourceOf(file) !== null;

export type PreviewShape = "portrait" | "square" | "landscape";
/**
 * شكل إطار المشغّل من أبعاد الصورة: طولي أو مربع أو عرضي. مقطع الهاتف الطولي في إطار عرضي يصغر إلى شريط ضيق، فالإطار يتبع المقطع.
 * بلا أبعاد صالحة يبقى عرضيًا.
 */
export function previewShape(width?: number | null, height?: number | null): PreviewShape {
  if (!width || !height || width < 0 || height < 0) return "landscape";
  const ratio = width / height;
  return ratio < 0.9 ? "portrait" : ratio <= 1.1 ? "square" : "landscape";
}

/**
 * مساحة الصورة داخل إطار يحتويها (`object-fit: contain`): إزاحتها عن حافتي الإطار وعرضها وارتفاعها بالبكسل. العلامة المائية توضع عليها، لا
 * على الشريطين الأسودين حولها. بلا أبعاد للمقطع بعدُ تُعدّ الصورة الإطار كله.
 */
export function pictureBox(frameWidth: number, frameHeight: number, width: number, height: number) {
  const fw = frameWidth > 0 ? frameWidth : 0, fh = frameHeight > 0 ? frameHeight : 0;
  if (!fw || !fh || !(width > 0) || !(height > 0)) return { x: 0, y: 0, w: fw, h: fh };
  const scale = Math.min(fw / width, fh / height), w = width * scale, h = height * scale;
  return { x: (fw - w) / 2, y: (fh - h) / 2, w, h };
}

/** مقطع يُشاهَد: النسخة الخفيفة التي صنعها الخادم من أصل، ومعها مصغّرة الأصل نفسه إن وُجدت. */
export type PreviewClip = { proxy: MaterialFile; thumbnail: MaterialFile | null };
/**
 * ما تعرضه معاينة الطاقم: النسخ الخفيفة التي أنتجها الخادم وحدها (MP4 متحقق)، والملصق والمصغّرات (الخادم وحده ينتجها: لا رفع لنوع
 * `thumbnail`). بلا نسخة من الخادم يظهر الملصق أو حالة «قيد التحضير»، لا نسخة الهاتف. المادة بعدة ملفات فيديو لها مقطع لكل أصل، بترتيب
 * ملفاتها، ومصغّرة المقطع هي المشتقة من الأصل نفسه (`derived_from_id`).
 */
export function staffPreview(material: Pick<Material, "files" | "thumbnail_file_id"> & { material_types?: readonly string[] }) {
  const verified = material.files.filter(file => file.state === "verified");
  const thumbnails = verified.filter(file => file.kind === "thumbnail"), originals = verified.filter(file => file.kind === "original");
  const clips: PreviewClip[] = verified.filter(file => file.kind === "proxy" && file.mime_type === "video/mp4" && serverMade(file))
    .map(proxy => ({ proxy, thumbnail: thumbnails.find(file => sourceOf(file) === sourceOf(proxy)) ?? null }));
  const poster = thumbnails.find(file => file.id === material.thumbnail_file_id) ?? thumbnails[0] ?? null;
  // صورة ثابتة: مصغّرتها التي صنعها الخادم من أصل صورة هي معاينتها (لا نسخة خفيفة لصورة). إن لم يُرَ الأصل فمصغّرة بلا مقطع
  // في مادة نوعها «صور».
  const stills = !!material.material_types?.includes("photos"), played = new Set(clips.map(clip => sourceOf(clip.proxy)));
  const photos = thumbnails.filter(file => {
    const source = sourceOf(file), original = originals.find(item => item.id === source);
    return source !== null && !played.has(source) && (original ? isImage(original) : stills);
  });
  // أصل لا يُصنع له شيء يُعرض: صورة ليست JPEG ولا PNG (HEIC وRAW)، أو بلا نوع معلن في مادة صور. الأصل محفوظ، ولا معاينة تُنتظر.
  const unseen = originals.length > 0 && originals.every(file => (isImage(file) && !previewable.includes(file.mime_type ?? "")) || (!file.mime_type && stills));
  return { proxy: clips[0]?.proxy ?? null, poster, thumbnails, clips, photos, unseen: unseen && !clips.length && !photos.length };
}
const previewable = ["image/jpeg", "image/png"];
const isImage = (file: MaterialFile) => (file.mime_type ?? "").startsWith("image/");
