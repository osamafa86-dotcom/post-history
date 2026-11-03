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
import { myTaskRoles } from "@/lib/assignment-policy";
import { tagAdmins } from "@/lib/tag-policy";
import { platformAdmins } from "@/lib/platform-policy";
import { staffReaders } from "@/lib/staff-policy";
import type { IconName } from "./icon";

export type NavGroup = "newsroom" | "library" | "admin";
export type NavItem = { key: string; href: string; label: string; short: string; active: boolean; group: NavGroup; icon: IconName };

/**
 * وجهات التنقّل بحسب الدور (W1، `Web/Sidebar`): ثلاث مجموعات (غرفة الأخبار، المكتبة، الإدارة) بالصفحات القائمة وحدها، وبند واحد نشط
 * (`aria-current="page"`). الشريط لا يعرض ما لا يملكه الدور (E5)؛ وحساب المشتري لا يرى غير المتجر ومؤسسته.
 * لا تُضاف وجهة لصفحة لم تُبنَ (المحرر العاجل والأرشيف الجاهز: ADR 0090). «المهام» لفريق الإنتاج (W5، ADR 0097).
 * الإدارة بترتيب إطارات A1–A6: المستخدمون، الوسوم، النماذج، المال، الإعدادات، ثم المؤسسات والقواعد والعمولة والتعارض (ADR 0102).
 */
export function navItems(me: Me, locale: Locale, pathname: string): NavItem[] {
  const m = messages[locale], short = m.shell.short as Record<string, string>, path = pathname.replace(/^\/(ar|en)(?=\/|$)/, ""), ends = (page: string) => path === `/${page}` || path.startsWith(`/${page}/`);
  const item = (key: string, label: string, active: boolean, group: NavGroup, icon: IconName, page = key): NavItem => ({ key, href: `/${locale}/${page}`, label, short: short[key] ?? label, active, group, icon });
  const store = /^\/store(\/|$)/.test(path), licenses = /^\/store\/licenses(\/|$)/.test(path);
  // المشتري (S1–S4): المواد وتراخيصي والطلبات ومؤسسته؛ والسلة زرّ بعدّادها في الشريط نفسه لا وجهة هنا، فصفحتها لا تنشّط وجهة.
  const buyerOrders = /^\/store\/orders(\/|$)/.test(path), cart = /^\/store\/cart(\/|$)/.test(path);
  if (isBuyer(me)) return [
    item("store", m.store.nav.materials, store && !licenses && !buyerOrders && !cart, "library", "store"),
    item("licenses", m.store.nav.licenses, licenses, "library", "license", "store/licenses"),
    item("orders", m.store.nav.orders, buyerOrders, "library", "orders", "store/orders"),
    item("organization", m.buyers.myOrganization, ends("organization"), "admin", "org"),
  ];
  const has = (...roles: RoleName[]) => hasRole(me, ...roles);
  return [
    item("inbox", m.inbox, ends("inbox") || ends("materials"), "newsroom", "inbox"),
    ...(has("supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin") ? [item("board", m.board.title, ends("board"), "newsroom", "wall")] : []),
    ...(hasRole(me, ...myTaskRoles) ? [item("tasks", m.tasks.nav, ends("tasks"), "newsroom", "tasks")] : []),
    ...(has("reporter") ? [item("my-materials", m.mine.nav, ends("my-materials"), "newsroom", "mine")] : []),
    ...(hasRole(me, ...earnerRoles) ? [item("earnings", m.earnings.nav, ends("earnings"), "newsroom", "money")] : []),
    ...(hasRole(me, ...uploadRoles) ? [item("upload", m.upload.nav, ends("upload"), "newsroom", "upload")] : []),
    item("notifications", m.notice.title, ends("notifications"), "newsroom", "bell"),
    item("form-preview", m.formPreview, ends("form-preview"), "newsroom", "preview"),
    ...(hasRole(me, ...catalogRoles) ? [item("store", m.store.title, store && !licenses && !/^\/store\/orders(\/|$)/.test(path), "library", "store")] : []),
    ...(has("system_admin", "finance", "rights_officer") ? [item("licenses", m.licenses.nav, licenses, "library", "license", "store/licenses")] : []),
    ...(has("system_admin", "finance") ? [item("orders", m.orders.staffNav, /^\/store\/orders(\/|$)/.test(path), "library", "orders", "store/orders")] : []),
    ...(hasRole(me, ...templateRoles) ? [item("license-templates", m.templates.nav, ends("license-templates"), "library", "template")] : []),
    ...(hasRole(me, ...staffReaders) ? [item("admin", m.admin.nav, ends("admin"), "admin", "users")] : []),
    ...(hasRole(me, ...tagAdmins) ? [item("tags", m.tags.nav, ends("tags"), "admin", "tag")] : []),
    ...(hasRole(me, ...formReaders) ? [item("forms", m.formsAdmin.nav, ends("forms"), "admin", "form")] : []),
    ...(hasRole(me, ...payoutStaff) ? [item("payouts", m.payouts.nav, ends("payouts"), "admin", "money")] : []),
    ...(hasRole(me, ...platformAdmins) ? [item("settings", m.settings.nav, ends("settings"), "admin", "settings")] : []),
    ...(hasRole(me, ...organizationAdmins) ? [item("buyer-organizations", m.buyers.nav, ends("buyer-organizations"), "admin", "org")] : []),
    ...(has("system_admin", "editor_in_chief") ? [item("notification-rules", m.rules.title, ends("notification-rules"), "admin", "rules")] : []),
    ...(hasRole(me, ...commissionReaders) ? [item("commission-rules", m.commission.nav, ends("commission-rules"), "admin", "percent")] : []),
    ...(hasRole(me, ...conflictRoles) ? [item("invite-conflicts", m.conflicts.nav, ends("invite-conflicts"), "admin", "conflict")] : []),
  ];
}

/** المجموعات بترتيبها مع بنودها؛ المجموعة الفارغة لا تُعرض. */
export function navGroups(items: NavItem[]): [NavGroup, NavItem[]][] {
  return (["newsroom", "library", "admin"] as NavGroup[]).map(group => [group, items.filter(item => item.group === group)] as [NavGroup, NavItem[]]).filter(([, list]) => list.length > 0);
}

/**
 * الشريط السفلي على الجوال (M1، M3): أربع وجهات بترتيب الأولوية مما يملكه الدور (الوارد ثم المهام كما في M3)، و«المزيد» خامسة تفتح الباقي. التنبيهات بينها دائمًا.
 * والنشط في «المزيد» يجعلها هي النشطة (M5).
 */
export function bottomItems(items: NavItem[]): { primary: NavItem[]; more: NavItem[] } {
  const order = ["inbox", "tasks", "board", "my-materials", "store", "upload", "earnings"], notifications = items.find(item => item.key === "notifications");
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
