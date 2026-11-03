import type { components } from "@/generated/schema";

/**
 * قبول الدعوة (S5) بقواعد العقد: رمز الدعوة 32–256 محرفًا (`reset_token`)، وكلمة المرور 12–256 (`new_password`)، ورمز TOTP ستة أرقام.
 * الرمز محارف مرئية بلا مسافات، فما يُلصق بمسافات أو أسطر في طرفيه يُقصّ، وما فيه محارف تحكم يُرفض قبل الإرسال.
 */
export const passwordMin = 12, passwordMax = 256;
export const cleanToken = (value: string) => value.trim();
export const validToken = (value: string) => /^[\x21-\x7e]{32,256}$/.test(value);
export function validPassword(value: string) { const length = Array.from(value).length; return length >= passwordMin && length <= passwordMax && value.length <= passwordMax; }

type Completion = components["schemas"]["RecoveryCompletion"];
export function inviteInput(body: Record<string, unknown>): { reset_token: string; new_password: string } | null {
  const token = typeof body.reset_token === "string" ? cleanToken(body.reset_token) : "", password = body.new_password;
  if (!validToken(token) || typeof password !== "string" || !validPassword(password)) return null;
  return { reset_token: token, new_password: password };
}
export function totpInput(body: Record<string, unknown>): { totp_code: string } | null {
  return typeof body.totp_code === "string" && /^[0-9]{6}$/.test(body.totp_code) ? { totp_code: body.totp_code } : null;
}

/** بيانات ربط TOTP كما يعيدها العقد وحدها: سرّ base32 بطوله، ورابط `otpauth://totp/` بلا غيره. تُعرض مرة ولا تُحفظ. */
export function safeEnrollment(value: Completion["totp_enrollment"] | undefined): Completion["totp_enrollment"] | null {
  if (!value || typeof value.secret_base32 !== "string" || !/^[A-Z2-7]{16,64}$/.test(value.secret_base32)) return null;
  if (typeof value.otpauth_uri !== "string" || !value.otpauth_uri.startsWith("otpauth://totp/") || value.otpauth_uri.length > 2048 || /[\s<>"']/.test(value.otpauth_uri)) return null;
  return { secret_base32: value.secret_base32, otpauth_uri: value.otpauth_uri };
}
/** السرّ في مجموعات من أربعة للقراءة والكتابة اليدوية في تطبيق المصادقة. */
export const groupSecret = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? secret;

/**
 * الرمز من جزء الرابط بعد `#` (`#token=…`) لا من الاستعلام: الجزء لا يصل إلى الخادم ولا إلى سجلات الطلبات، ويُمحى من شريط العنوان بعد قراءته.
 */
export function tokenFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return value && validToken(cleanToken(value)) ? cleanToken(value) : null;
}
