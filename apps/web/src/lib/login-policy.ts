import { messages, plural, type Locale, type PluralForms } from "./i18n";

export type LoginFailure = { kind: "credentials" } | { kind: "totp" } | { kind: "throttled"; seconds: number | null } | { kind: "unavailable" };

/**
 * سبب تعذّر الدخول كما يقوله الـBFF: حدّ المعدّل (429) وتعذّر الخادم (5xx) ليسا «بيانات خاطئة»، فلا يُقال لصاحب كلمة مرور صحيحة «تحقق من
 * البيانات». 429 يردّه الخادم للبريد الموجود وغير الموجود سواء، فذكره لا يدل على وجود حساب.
 */
export function loginFailure(status: number, body: { code?: string; details?: { retry_after_seconds?: unknown } }): LoginFailure {
  if (status === 429) { const seconds = body.details?.retry_after_seconds; return { kind: "throttled", seconds: typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null }; }
  if (status >= 500) return { kind: "unavailable" };
  return body.code === "totp_required" ? { kind: "totp" } : { kind: "credentials" };
}

/** مهلة الانتظار المقروءة: ثوانٍ حتى دقيقة ونصف، ثم دقائق مقرّبة إلى أعلى (لا يُدعى أحد إلى المحاولة قبل أوانها). */
export function loginFailureText(failure: LoginFailure, locale: Locale): string {
  const m = messages[locale];
  if (failure.kind === "totp") return m.totpRequired;
  if (failure.kind === "unavailable") return m.loginUnavailable;
  if (failure.kind === "credentials") return m.loginFailed;
  if (failure.seconds === null) return m.loginThrottledSoon;
  const wait = failure.seconds <= 90 ? plural(failure.seconds, m.loginWait.seconds as PluralForms, locale) : plural(Math.ceil(failure.seconds / 60), m.loginWait.minutes as PluralForms, locale);
  return m.loginThrottled.replace("{wait}", wait);
}
