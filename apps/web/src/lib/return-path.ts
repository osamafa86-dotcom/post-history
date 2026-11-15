import { pageNames } from "./page-titles";
import type { Locale } from "./i18n";

// صفحات بلا جلسة لا يُعاد إليها بعد الدخول.
const publicPages = ["login", "forgot-password", "reset-password", "invite", "privacy", "verify/[number]"];
const pattern = Object.keys(pageNames).filter(page => !publicPages.includes(page))
  .map(page => page.split("/").map(part => (/^\[.+\]$/.test(part) ? "[A-Za-z0-9-]{1,64}" : part)).join("/")).join("|");
const internal = new RegExp(`^/(?:ar|en)/(?:${pattern})$`);

/**
 * الصفحة التي يُعاد إليها بعد الدخول (جلسة انتهت وسط العمل، أو رابط عميق فُتح بلا جلسة): مسار من صفحات هذا التطبيق وحدها ومعه استعلامه،
 * على الأصل نفسه. عنوان خارجي، أو `//`، أو شرطة مائلة عكسية، أو محرف تحكم، أو صفحة لا نعرفها: لا عودة، فيذهب الداخل إلى صفحة دوره.
 */
export function returnPath(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value, origin); } catch { return null; }
  if (url.origin !== origin || !internal.test(url.pathname)) return null;
  return url.pathname + url.search;
}

/** وجهة ما بعد الدخول: صفحة العودة بلغة صفحة الدخول التي اختارها الداخل، وإلا صفحة بداية دوره. */
export function loginTarget(next: string | null | undefined, locale: Locale, home: string): string {
  return next ? next.replace(/^\/(?:ar|en)(?=\/)/, `/${locale}`) : `/${locale}/${home}`;
}
