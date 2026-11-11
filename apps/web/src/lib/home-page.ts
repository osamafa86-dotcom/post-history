import type { Me } from "./types";
import { hasRole, materialReaders } from "./review";
import { isBuyer } from "./buyer-policy";
import { payoutStaff } from "./earnings-policy";

export type HomePage = "store" | "my-materials" | "inbox" | "payouts" | "notifications";

/** مراسل لا يحمل دورًا من أدوار المكتب: صفحته «موادي»، ووارد المكتب وإنذاره ليسا له. */
export const reporterOnly = (me: Me) => hasRole(me, "reporter") && !hasRole(me, ...materialReaders.filter(role => role !== "reporter"));

/**
 * صفحة البداية لكل دور: صفحة يقرؤها دوره، فلا يهبط أحد بعد الدخول على 403. المشتري في المتجر، والمراسل في موادّه، ومكتب المواد في الوارد،
 * والمالية في الصرف، ومن لا يملك شيئًا منها في التنبيهات (لكل حساب). إليها يعيد شعار الشريط وزرّ «لا صلاحية» (E5).
 */
export function homePage(me: Me): HomePage {
  if (isBuyer(me)) return "store";
  if (reporterOnly(me)) return "my-materials";
  if (hasRole(me, ...materialReaders)) return "inbox";
  if (hasRole(me, ...payoutStaff)) return "payouts";
  return "notifications";
}
