import type { Metadata } from "next";
import { isLocale, messages, type Locale } from "./i18n";

type Messages = (typeof messages)[Locale];

/**
 * اسم كل صفحة لعنوان المتصفح (WCAG 2.4.2): التبويبات تتميّز، وقارئ الشاشة يعلن أين صار. الاسم ثابت من الموارد ودالّةٌ في اللغة وحدها:
 * لا عنوان مادة ولا اسم مراسل ولا مكان في عنوان صفحة (`apps/web/CLAUDE.md`). وجهة لها بند في التنقّل تأخذ اسمه نفسه.
 */
export const pageNames = {
  inbox: (m: Messages) => m.inbox, board: (m: Messages) => m.board.title, tasks: (m: Messages) => m.tasks.nav, "tasks/[id]": (m: Messages) => m.pageTitles.task,
  "materials/[id]": (m: Messages) => m.pageTitles.material, "my-materials": (m: Messages) => m.mine.nav, earnings: (m: Messages) => m.earnings.nav, upload: (m: Messages) => m.upload.nav,
  notifications: (m: Messages) => m.notice.title, "form-preview": (m: Messages) => m.formPreview, archive: (m: Messages) => m.archive.nav,
  store: (m: Messages) => m.store.title, "store/[id]": (m: Messages) => m.pageTitles.storeItem, "store/cart": (m: Messages) => m.pageTitles.cart,
  "store/licenses": (m: Messages) => m.licenses.nav, "store/licenses/[id]": (m: Messages) => m.pageTitles.license,
  "store/orders": (m: Messages) => m.store.nav.orders, "store/orders/[id]": (m: Messages) => m.pageTitles.order, "store/orders/[id]/invoice": (m: Messages) => m.store.invoice.title,
  organization: (m: Messages) => m.buyers.myOrganization, "license-templates": (m: Messages) => m.templates.nav, admin: (m: Messages) => m.admin.nav, tags: (m: Messages) => m.tags.nav,
  forms: (m: Messages) => m.formsAdmin.nav, payouts: (m: Messages) => m.payouts.nav, settings: (m: Messages) => m.settings.nav, "buyer-organizations": (m: Messages) => m.buyers.nav,
  "notification-rules": (m: Messages) => m.rules.title, "commission-rules": (m: Messages) => m.commission.nav, "invite-conflicts": (m: Messages) => m.conflicts.nav,
  "recovery-requests/[id]": (m: Messages) => m.pageTitles.recovery, security: (m: Messages) => m.security.title,
  login: (m: Messages) => m.pageTitles.login, "forgot-password": (m: Messages) => m.pageTitles.forgot, "reset-password": (m: Messages) => m.pageTitles.reset, invite: (m: Messages) => m.pageTitles.invite,
  privacy: (m: Messages) => m.privacy.title, "verify/[number]": (m: Messages) => m.pageTitles.verify,
};
export type PageName = keyof typeof pageNames;

export const pageTitle = (locale: Locale, page: PageName) => `${pageNames[page](messages[locale])} · ${messages[locale].product}`;

/** `generateMetadata` لصفحة: `export const generateMetadata = pageMetadata("inbox");` */
export function pageMetadata(page: PageName) {
  return async ({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> => { const { locale } = await params; return { title: pageTitle(isLocale(locale) ? locale : "ar", page) }; };
}
