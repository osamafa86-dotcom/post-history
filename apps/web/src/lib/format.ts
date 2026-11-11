/**
 * لغة المنسّقات، مثبّتة الأرقام. الأرقام الافتراضية للعربية تختلف بين المتصفحات وإصدارات ICU، فلا يُمرَّر رمز اللغة الخام إلى `Intl`:
 * قاعدة الفحص في `eslint.config.mjs` ترفض تمرير رمز اللغة الخام إلى منسّقات `Intl`، وكل منسّق يأخذ لغته من هنا.
 */
type Locale = "ar" | "en";

/** الأعداد والمبالغ والنِّسب: العربية بأرقام لاتينية دائمًا. */
export const numberLocale = (locale: Locale) => locale === "ar" ? "ar-u-nu-latn" : "en";

/** التواريخ: أسماء الشهور الشامية («تشرين الأول») بأرقام لاتينية. */
export const dateLocale = (locale: Locale) => locale === "ar" ? "ar-PS-u-nu-latn" : "en";

/** اسم المحافظة بلغة الواجهة من جدول العرض؛ ما ليس فيه يبقى كما وصل. القيمة المرسَلة إلى الخادم لا تتغيّر. */
export function governorateName(value: string, names: Record<string, string>) {
  return names[value.trim()] ?? value;
}
