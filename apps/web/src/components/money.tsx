import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n";
import { formatMoney } from "@/lib/store-format";

/** مبلغ داخل جملة: معزول الاتجاه (`bdi` باتجاه ltr)، كي لا ينقلب رمز العملة ولا الإشارة في السياق العربي. */
export function Money({ price, locale }: { price: Parameters<typeof formatMoney>[0]; locale: Locale }) {
  return <bdi dir="ltr" className="money">{formatMoney(price, locale)}</bdi>;
}

/** زوج رقمي أو مدى أو نسبة داخل جملة («2 / 3»، «10–20»): يُقرأ من اليسار كما كُتب. */
export function Ltr({ children }: { children: ReactNode }) {
  return <bdi dir="ltr">{children}</bdi>;
}

/** يملأ قالب نص بعناصر: كل `{name}` يأخذ عنصره والباقي نص كما هو. للجمل التي تحمل مبلغًا أو رقمًا يلزمه عزل اتجاه، بدل `replace` النصي. */
export function fillNodes(template: string, parts: Record<string, ReactNode>): ReactNode[] {
  return template.split(/(\{[a-zA-Z]+\})/).filter(Boolean).map((piece, i) => { const name = /^\{([a-zA-Z]+)\}$/.exec(piece)?.[1]; return name && name in parts ? <span key={i}>{parts[name]}</span> : piece; });
}
