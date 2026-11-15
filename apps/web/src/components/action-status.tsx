import { messages, type Locale } from "@/lib/i18n";
import type { Refusal } from "@/lib/refusal-policy";
/** سطر حالة الكتابة. الرفض المعروف برمزه (`refusal`) يُقال بجملته بدل الرسالة العامة لحالته؛ والشروط الفاشلة للإدراج بأسمائها. */
export function ActionStatus({ status, locale, refusal }: { status: number; locale: Locale; refusal?: Refusal | null }) {
  if (!status) return null;
  const m = messages[locale].review, r = messages[locale].refusals, conditions = messages[locale].listing.conditions;
  const known = status !== 200 && refusal ? r[refusal.code].replace("{conditions}", (refusal.failed ?? []).map(name => conditions[name]).join(messages[locale].shell.listSeparator)) : null;
  const text = known ?? (status === 200 ? m.saved : status === 412 ? m.changed : status === 403 ? m.forbidden : status === 409 ? m.conflict : status === 422 || status === 400 ? m.invalid : status === 428 ? m.versionMissing : m.failed);
  return <p className={`notice${status === 200 ? "" : " error"}`} role={status === 200 ? "status" : "alert"} data-refusal={known ? refusal!.code : undefined}>{text}</p>;
}
