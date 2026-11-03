// قاعدة النص الحرّ القصير في العقد (`MaterialTag` و`PlatformSettingsUpdate`، ADR 0086 و0099): لا مسافة في الطرفين ولا محارف تحكم
// أو اتجاه، والطول بنقاط الترميز كما يعدّها الخادم. المحارف مكتوبة هنا بتهريبها وحده، فلا محرف اتجاه خامًا في المصدر.
const hidden = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const hiddenAll = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** عدد نقاط الترميز (`Array.from`) لا وحدات UTF-16. */
export const codePoints = (value: string) => Array.from(value).length;

/** يطابق نمط العقد: 1 إلى `max` نقطة ترميز، بلا محرف خفيّ، ولا مسافة من أي نوع في أوله ولا في آخره. */
export function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && codePoints(value) >= 1 && codePoints(value) <= max && !hidden.test(value) && !/^\s/u.test(value) && !/\s$/u.test(value);
}

/** تنظيف الإدخال عند الكتابة واللصق: تُحذف محارف التحكم والاتجاه لأن الخادم يرفضها. */
export const stripHidden = (value: string) => value.replace(hiddenAll, "");

/** ما يُرسل: التنظيف ثم قصّ المسافتين في الطرفين. */
export const cleanText = (value: string) => stripHidden(value).trim();

/** يملأ القيم بين `{}` في نص من ملفات الموارد. */
export function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}

/** حروف الصورة الرمزية (`Web/Avatar`) من اسم العمل وحده: الحرف الأول من أول كلمتين. لا بريد ولا اسم حقيقي. */
export function initialsOf(name: string | null | undefined, fallback = "?") {
  const words = (name ?? "").split(/[\s·]+/u).filter(Boolean);
  if (!words.length) return fallback;
  return words.length > 1 ? Array.from(words[0])[0] + Array.from(words[1])[0] : Array.from(words[0]).slice(0, 2).join("");
}
