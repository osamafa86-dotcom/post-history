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
import type { IconName } from "./icon";

export type NavGroup = "newsroom" | "library" | "admin";
export type NavItem = { key: string; href: string; label: string; short: string; active: boolean; group: NavGroup; icon: IconName };

/**
 * وجهات التنقّل بحسب الدور (W1، `Web/Sidebar`): ثلاث مجموعات (غرفة الأخبار، المكتبة، الإدارة) بالصفحات القائمة وحدها، وبند واحد نشط
 * (`aria-current="page"`). الشريط لا يعرض ما لا يملكه الدور (E5)؛ وحساب المشتري لا يرى غير المتجر ومؤسسته.
 * لا تُضاف وجهة لصفحة لم تُبنَ (المهام والمحرر العاجل والأرشيف الجاهز والوسوم: ADR 0090).
 */
export function navItems(me: Me, locale: Locale, pathname: string): NavItem[] {
  const m = messages[locale], short = m.shell.short as Record<string, string>, path = pathname.replace(/^\/(ar|en)(?=\/|$)/, ""), ends = (page: string) => path === `/${page}` || path.startsWith(`/${page}/`);
  const item = (key: string, label: string, active: boolean, group: NavGroup, icon: IconName, page = key): NavItem => ({ key, href: `/${locale}/${page}`, label, short: short[key] ?? label, active, group, icon });
  const store = /^\/store(\/|$)/.test(path), licenses = /^\/store\/licenses(\/|$)/.test(path), orders = /^\/store\/(orders|cart)(\/|$)/.test(path);
  if (isBuyer(me)) return [
    item("store", m.store.title, store && !licenses && !orders, "library", "store"),
    item("licenses", m.licenses.nav, licenses, "library", "license", "store/licenses"),
    item("orders", m.orders.nav, orders, "library", "orders", "store/cart"),
    item("organization", m.buyers.myOrganization, ends("organization"), "admin", "org"),
  ];
  const has = (...roles: RoleName[]) => hasRole(me, ...roles);
  return [
    item("inbox", m.inbox, ends("inbox") || ends("materials"), "newsroom", "inbox"),
    ...(has("supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin") ? [item("board", m.board.title, ends("board"), "newsroom", "wall")] : []),
    ...(has("reporter") ? [item("my-materials", m.mine.nav, ends("my-materials"), "newsroom", "mine")] : []),
    ...(hasRole(me, ...earnerRoles) ? [item("earnings", m.earnings.nav, ends("earnings"), "newsroom", "money")] : []),
    ...(hasRole(me, ...uploadRoles) ? [item("upload", m.upload.nav, ends("upload"), "newsroom", "upload")] : []),
    item("notifications", m.notice.title, ends("notifications"), "newsroom", "bell"),
    item("form-preview", m.formPreview, ends("form-preview"), "newsroom", "preview"),
    ...(hasRole(me, ...catalogRoles) ? [item("store", m.store.title, store && !licenses && !/^\/store\/orders(\/|$)/.test(path), "library", "store")] : []),
    ...(has("system_admin", "finance", "rights_officer") ? [item("licenses", m.licenses.nav, licenses, "library", "license", "store/licenses")] : []),
    ...(has("system_admin", "finance") ? [item("orders", m.orders.staffNav, /^\/store\/orders(\/|$)/.test(path), "library", "orders", "store/orders")] : []),
    ...(hasRole(me, ...templateRoles) ? [item("license-templates", m.templates.nav, ends("license-templates"), "library", "template")] : []),
    ...(has("system_admin") ? [item("admin", m.admin.title, ends("admin"), "admin", "users")] : []),
    ...(hasRole(me, ...formReaders) ? [item("forms", m.formsAdmin.title, ends("forms"), "admin", "form")] : []),
    ...(has("system_admin", "editor_in_chief") ? [item("notification-rules", m.rules.title, ends("notification-rules"), "admin", "rules")] : []),
    ...(hasRole(me, ...organizationAdmins) ? [item("buyer-organizations", m.buyers.nav, ends("buyer-organizations"), "admin", "org")] : []),
    ...(hasRole(me, ...payoutStaff) ? [item("payouts", m.payouts.nav, ends("payouts"), "admin", "payout")] : []),
    ...(hasRole(me, ...commissionReaders) ? [item("commission-rules", m.commission.nav, ends("commission-rules"), "admin", "percent")] : []),
    ...(hasRole(me, ...conflictRoles) ? [item("invite-conflicts", m.conflicts.nav, ends("invite-conflicts"), "admin", "conflict")] : []),
  ];
}

/** المجموعات بترتيبها مع بنودها؛ المجموعة الفارغة لا تُعرض. */
export function navGroups(items: NavItem[]): [NavGroup, NavItem[]][] {
  return (["newsroom", "library", "admin"] as NavGroup[]).map(group => [group, items.filter(item => item.group === group)] as [NavGroup, NavItem[]]).filter(([, list]) => list.length > 0);
}

/**
 * الشريط السفلي على الجوال (M1): أربع وجهات بترتيب الأولوية مما يملكه الدور، و«المزيد» خامسة تفتح الباقي. التنبيهات بينها دائمًا.
 * والنشط في «المزيد» يجعلها هي النشطة (M5).
 */
export function bottomItems(items: NavItem[]): { primary: NavItem[]; more: NavItem[] } {
  const order = ["inbox", "board", "my-materials", "store", "upload", "earnings"], notifications = items.find(item => item.key === "notifications");
  const ranked = order.map(key => items.find(item => item.key === key)).filter((item): item is NavItem => !!item);
  const primary = [...ranked.slice(0, notifications ? 3 : 4), ...(notifications ? [notifications] : [])];
  return { primary, more: items.filter(item => !primary.includes(item)) };
}

/** الحرفان الأولان من اسم العمل للصورة الرمزية (`Web/Avatar`)؛ بلا اسم عمل فالحرف الأول من الدور. لا بريد ولا اسم حقيقي. */
export function initials(me: Me, locale: Locale): string {
  const name = workName(me.work_name) ?? userLine(me, locale);
  const words = name.split(/[\s·]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : [...(words[0] ?? "?")].slice(0, 2).join("")).toLocaleUpperCase(locale);
}

/** سطر المستخدم في طرف الشريط: اسم العمل الداخلي إن وُجد (لا بريد ولا اسم حقيقي) ثم دوره الأول. */
export function userLine(me: Me, locale: Locale): string {
  const t = messages[locale].topbar, role = me.roles[0]?.name, label = role ? t.roles[role] : null;
  return [workName(me.work_name), label].filter(Boolean).join(" · ") || t.account;
}
