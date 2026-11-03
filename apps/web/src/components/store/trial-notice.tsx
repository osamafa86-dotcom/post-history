"use client";
import { usePathname } from "next/navigation";
import { messages, type Locale } from "@/lib/i18n";
import { Icon } from "../icon";
import { useCartCount } from "./cart";

/**
 * لافتة التجربة المشتركة: نصّ السلة نفسه (`store.cartPage.sandbox`)، لا صياغة أخرى. لا تُخفى ولا تُغلق ما دام المزوّد تجريبيًا
 * (قرار المالك 2026-10-21). في هيكل المتجر كله وفي قواعد العمولة.
 */
export function TrialNotice({ locale }: { locale: Locale }) {
  return <p className="notice attention trial-notice no-print" role="note" data-testid="trial-notice"><Icon name="shield" size={16} /><span>{messages[locale].store.cartPage.sandbox}</span></p>;
}

/** اللافتة في هيكل المتجر (الكتالوج والمادة وتراخيصي والطلبات والفاتورة)؛ السلة بأصنافها تقولها بجانب زرّ الدفع، فلا تُكرَّر فوقها. */
export function StoreTrialNotice({ locale }: { locale: Locale }) {
  const cart = /^\/(ar|en)\/store\/cart(\/|$)/.test(usePathname() ?? ""), count = useCartCount();
  return cart && count > 0 ? null : <TrialNotice locale={locale} />;
}
