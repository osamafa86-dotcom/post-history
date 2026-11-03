import type { Me } from "./types";
import { hasRole, materialReaders } from "./review";
import { isBuyer } from "./buyer-policy";
import { payoutStaff } from "./earnings-policy";

export type HomePage = "store" | "inbox" | "payouts" | "notifications";

/**
 * صفحة البداية لكل دور: صفحة يقرؤها دوره، فلا يهبط أحد بعد الدخول على 403. المشتري في المتجر، ومن يقرأ المواد في الوارد،
 * والمالية في الصرف، ومن لا يملك شيئًا منها في التنبيهات (لكل حساب). إليها يعيد شعار الشريط وزرّ «لا صلاحية» (E5).
 */
export function homePage(me: Me): HomePage {
  if (isBuyer(me)) return "store";
  if (hasRole(me, ...materialReaders)) return "inbox";
  if (hasRole(me, ...payoutStaff)) return "payouts";
  return "notifications";
}
