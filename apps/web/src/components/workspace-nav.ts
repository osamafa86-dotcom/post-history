import type { Me, RoleName } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { hasRole } from "@/lib/review";
import { catalogRoles } from "./store/store-catalog";
import { uploadRoles } from "@/lib/upload-policy";
import { isBuyer, organizationAdmins } from "@/lib/buyer-policy";
import { commissionReaders } from "@/lib/commission-policy";
import { conflictRoles } from "@/lib/invite-conflict-policy";
import { earnerRoles, payoutStaff } from "@/lib/earnings-policy";
import { templateRoles } from "@/lib/license-policy";
import { formReaders } from "@/lib/form-admin";
import { workName } from "@/lib/work-name";

export type NavItem = { key: string; href: string; label: string; active: boolean };

/**
 * بنود الشريط العلوي بحسب الدور (Figma 193:593 للطاقم، 185:333 للمشتري): البنود نفسها التي كانت في الشريط الجانبي بترتيبها،
 * وبند واحد فقط نشط (`aria-current="page"`). حساب المشتري لا يرى غير المتجر ومؤسسته.
 */
export function navItems(me: Me, locale: Locale, pathname: string): NavItem[] {
  const m = messages[locale], path = pathname.replace(/^\/(ar|en)(?=\/|$)/, ""), ends = (page: string) => path === `/${page}` || path.startsWith(`/${page}/`);
  const item = (key: string, label: string, active: boolean, page = key): NavItem => ({ key, href: `/${locale}/${page}`, label, active });
  const store = /^\/store(\/|$)/.test(path), licenses = /^\/store\/licenses(\/|$)/.test(path), orders = /^\/store\/(orders|cart)(\/|$)/.test(path);
  if (isBuyer(me)) return [
    item("store", m.store.title, store && !licenses && !orders),
    item("licenses", m.licenses.nav, licenses, "store/licenses"),
    item("orders", m.orders.nav, orders, "store/cart"),
    item("organization", m.buyers.myOrganization, ends("organization")),
  ];
  const has = (...roles: RoleName[]) => hasRole(me, ...roles);
  return [
    item("inbox", m.inbox, ends("inbox")),
    ...(has("supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin") ? [item("board", m.board.title, ends("board"))] : []),
    ...(has("reporter") ? [item("my-materials", m.mine.nav, ends("my-materials"))] : []),
    ...(hasRole(me, ...earnerRoles) ? [item("earnings", m.earnings.nav, ends("earnings"))] : []),
    ...(hasRole(me, ...uploadRoles) ? [item("upload", m.upload.nav, ends("upload"))] : []),
    ...(hasRole(me, ...catalogRoles) ? [item("store", m.store.title, store && !licenses && !/^\/store\/orders(\/|$)/.test(path))] : []),
    item("form-preview", m.formPreview, ends("form-preview")),
    ...(hasRole(me, ...formReaders) ? [item("forms", m.formsAdmin.title, ends("forms"))] : []),
    item("notifications", m.notice.title, ends("notifications")),
    ...(has("system_admin", "editor_in_chief") ? [item("notification-rules", m.rules.title, ends("notification-rules"))] : []),
    ...(hasRole(me, ...templateRoles) ? [item("license-templates", m.templates.nav, ends("license-templates"))] : []),
    ...(has("system_admin", "finance", "rights_officer") ? [item("licenses", m.licenses.nav, licenses, "store/licenses")] : []),
    ...(hasRole(me, ...organizationAdmins) ? [item("buyer-organizations", m.buyers.nav, ends("buyer-organizations"))] : []),
    ...(has("system_admin", "finance") ? [item("orders", m.orders.staffNav, /^\/store\/orders(\/|$)/.test(path), "store/orders")] : []),
    ...(hasRole(me, ...payoutStaff) ? [item("payouts", m.payouts.nav, ends("payouts"))] : []),
    ...(hasRole(me, ...commissionReaders) ? [item("commission-rules", m.commission.nav, ends("commission-rules"))] : []),
    ...(hasRole(me, ...conflictRoles) ? [item("invite-conflicts", m.conflicts.nav, ends("invite-conflicts"))] : []),
    ...(has("system_admin") ? [item("admin", m.admin.title, ends("admin"))] : []),
  ];
}

/** سطر المستخدم في طرف الشريط: اسم العمل الداخلي إن وُجد (لا بريد ولا اسم حقيقي) ثم دوره الأول. */
export function userLine(me: Me, locale: Locale): string {
  const t = messages[locale].topbar, role = me.roles[0]?.name, label = role ? t.roles[role] : null;
  return [workName(me.work_name), label].filter(Boolean).join(" · ") || t.account;
}
