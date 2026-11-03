import type { Money } from './money';

export type CheckoutLocale = 'ar' | 'en';
export const CHECKOUT_LOCALES: readonly CheckoutLocale[] = ['ar', 'en'];

type Outcome = 'succeeded' | 'failed' | 'delayed' | 'duplicate' | 'out_of_order';
export const SANDBOX_OUTCOMES: readonly Outcome[] = ['succeeded', 'failed', 'delayed', 'duplicate', 'out_of_order'];

/**
 * نصوص صفحة الدفع التجريبية (ADR 0032، ملحق 2026-11-03) باللغتين. نص التجربة هو نص المتجر نفسه في الويب
 * (`store.cartPage.sandbox` في apps/web/messages)، فلا يرى المشتري صيغتين للتنبيه نفسه.
 */
export const SANDBOX_PAGE_MESSAGES: Record<CheckoutLocale, {
  title: string;
  notice: string;
  amount: string;
  outcomes: string;
  back: string;
  labels: Record<Outcome, { label: string; hint: string }>;
}> = {
  ar: {
    title: 'صفحة الدفع التجريبية',
    notice: 'بيئة دفع تجريبية: لا يُخصم مال حقيقي.',
    amount: 'المبلغ',
    outcomes: 'اختر نتيجة الدفع للتجربة',
    back: 'العودة إلى الطلب دون دفع',
    labels: {
      succeeded: { label: 'نجح الدفع', hint: 'إشعار نجاح واحد' },
      failed: { label: 'فشل الدفع', hint: 'إشعار فشل واحد' },
      delayed: { label: 'نجح بعد تأخير', hint: 'إشعار النجاح بعد ثانيتين' },
      duplicate: { label: 'نجاح مكرر', hint: 'إشعار النجاح نفسه عشر مرات' },
      out_of_order: { label: 'نجاح ثم فشل', hint: 'إشعار فشل يصل بعد النجاح' },
    },
  },
  en: {
    title: 'Test payment page',
    notice: 'Test payment environment: no real money is charged.',
    amount: 'Amount',
    outcomes: 'Choose a payment outcome to test',
    back: 'Back to the order without paying',
    labels: {
      succeeded: { label: 'Payment succeeds', hint: 'One success notification' },
      failed: { label: 'Payment fails', hint: 'One failure notification' },
      delayed: { label: 'Succeeds after a delay', hint: 'The success notification after two seconds' },
      duplicate: { label: 'Duplicate success', hint: 'The same success notification ten times' },
      out_of_order: { label: 'Success, then failure', hint: 'A failure notification arrives after the success' },
    },
  },
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * الصفحة نفسها: `lang` و`dir` بلغة الجلسة، ونص التجربة، والمبلغ معزولًا باتجاهه، وأزرار النتيجة بأسمائها، ورابط العودة إلى
 * الطلب حين يُضبط قالب العودة (من إعداد الخادم وحده). لا نص من الطلب غير المبلغ، ولا مورد خارجي (الأنماط في الصفحة).
 */
export function sandboxPage(ref: string, amount: Money, locale: CheckoutLocale, returnUrl: string | undefined): string {
  // العودة دون دفع إلى صفحة الطلب نفسها، بلا علامة الرجوع من المزوّد (`returned`) فلا ينتظر الويب دفعًا لم يحدث
  let backUrl: string | undefined;
  if (returnUrl) {
    const u = new URL(returnUrl);
    u.searchParams.delete('returned');
    u.searchParams.delete('outcome');
    backUrl = u.toString();
  }
  const t = SANDBOX_PAGE_MESSAGES[locale];
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const shown = `${(Number(amount.amountMinor) / 100).toFixed(2)} ${amount.currency}`;
  const buttons = SANDBOX_OUTCOMES.map((o) =>
    // من المتصفح ?return=1: بعد النتيجة يعود المشتري إلى صفحة الويب المعدّة (303)
    `<form method="post" action="${escape(encodeURIComponent(ref))}/${o}?return=1"><button type="submit">${escape(t.labels[o].label)}</button> <small>${escape(t.labels[o].hint)}</small></form>`,
  ).join('');
  const back = backUrl ? `<p><a href="${escape(backUrl)}">${escape(t.back)}</a></p>` : '';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escape(t.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem;line-height:1.5}` +
    `form{margin:.5rem 0}button{font:inherit;padding:.4rem .8rem}[role=note]{background:#fff4d6;border:1px solid #e0c060;padding:.5rem .75rem}</style></head>` +
    `<body><main><h1>${escape(t.title)}</h1><p role="note">${escape(t.notice)}</p>` +
    `<p>${escape(t.amount)}: <bdi dir="ltr">${escape(shown)}</bdi></p><h2>${escape(t.outcomes)}</h2>${buttons}${back}</main></body></html>`;
}
