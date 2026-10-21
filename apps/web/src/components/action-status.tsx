import { messages, type Locale } from "@/lib/i18n";
export function ActionStatus({ status, locale }: { status: number; locale: Locale }) {
  if (!status) return null;
  const m = messages[locale].review;
  const text = status === 200 ? m.saved : status === 412 ? m.changed : status === 403 ? m.forbidden : status === 409 ? m.conflict : status === 422 || status === 400 ? m.invalid : status === 428 ? m.versionMissing : m.failed;
  return <p className={`notice${status === 200 ? "" : " error"}`} role={status === 200 ? "status" : "alert"}>{text}</p>;
}
