"use client";
import { messages, formatDate, type Locale } from "@/lib/i18n";
import { fill } from "@/lib/admin-text";
import { Icon } from "./icon";

/**
 * رابط إعادة التعيين يُعرض مرة واحدة (ADR 0107، 0108): في ذاكرة المكوّن وحده، بلا حافظة ولا تخزين ولا سجل، ويُمحى بـ«سلّمته». المعتمِد
 * يسلّمه بيده أو يمليه؛ الرمز في جزء الرابط بعد `#` فلا يصل إلى خادم حين يُفتح. لقطة الشاشة لا يمنعها الويب؛ النص يقول ذلك صراحة.
 */
export function OneTimeLink({ link, expiresAt, locale, onDone, testId = "one-time-link" }: { link: string; expiresAt: string | null; locale: Locale; onDone: () => void; testId?: string }) {
  const t = messages[locale].recovery.link;
  return <section className="one-time-link" aria-labelledby={`${testId}-title`} data-testid={testId}>
    <h3 id={`${testId}-title`}><Icon name="key" size={16} />{t.title}</h3>
    <p className="muted">{t.lead}</p>
    <p className="notice" role="status">{t.once}</p>
    <div className="one-time-value"><span className="caption">{t.label}</span><output className="mono" dir="ltr" data-testid="reset-link">{link}</output></div>
    {expiresAt && <p className="caption">{fill(t.expires, { time: formatDate(expiresAt, locale) })}</p>}
    <div className="actions"><button type="button" className="secondary" onClick={onDone}>{t.done}</button></div>
  </section>;
}
