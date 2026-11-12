import type { Material, MaterialFile } from "./types";
import { uuid } from "./query";

/**
 * ملف صنعه الخادم: مشتق من ملف آخر (`derived_from_id` غير فارغ). النسخة الخفيفة التي يرفعها الهاتف ملف `proxy` أيضًا لكنه مرفوع لا مشتق،
 * فقد يحمل ما لم يجرّده الخادم. الحقل يُقرأ بحذر: ما لم يصل من الخادم بمعرّف صحيح لا يُعدّ مشتقًا (يُغلق ولا يُفتح).
 */
export function serverMade(file: MaterialFile): boolean {
  const source = (file as MaterialFile & { derived_from_id?: unknown }).derived_from_id;
  return typeof source === "string" && uuid.test(source);
}

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
 * ما تعرضه معاينة الطاقم: النسخة الخفيفة التي أنتجها الخادم وحدها (MP4 متحقق)، والملصق والمصغّرات (الخادم وحده ينتجها: لا رفع لنوع
 * `thumbnail`). بلا نسخة من الخادم يظهر الملصق أو حالة «قيد التحضير»، لا نسخة الهاتف.
 */
export function staffPreview(material: Pick<Material, "files" | "thumbnail_file_id">) {
  const verified = material.files.filter(file => file.state === "verified");
  const proxy = verified.find(file => file.kind === "proxy" && file.mime_type === "video/mp4" && serverMade(file)) ?? null;
  const thumbnails = verified.filter(file => file.kind === "thumbnail");
  const poster = thumbnails.find(file => file.id === material.thumbnail_file_id) ?? thumbnails[0] ?? null;
  return { proxy, poster, thumbnails };
}
