import type { components } from "@/generated/schema";
import { cleanText, validText } from "./admin-text";
import { uuid } from "./query";
import { validToken } from "./invite-policy";

/**
 * استعادة الحساب بلا بريد (ADR 0107، 0108) بقواعد العقد: الرمز الاحتياطي base32 بحروف كبيرة (يُكتب بمسافات أو شرطات أو بحروف صغيرة
 * فيُطبَّع قبل الإرسال)، ورابط إعادة التعيين يبنيه المتصفح من مصدره والرمز في جزء الرابط بعد `#` فلا يصل إلى خادم ولا سجل، وكل ردّ
 * يمرّ بالحقول التي يعرضها الويب وحدها.
 */
export type ResetReason = components["schemas"]["PasswordResetReason"];
export type PasswordResetLink = components["schemas"]["PasswordResetLink"];
export type RecoveryCodes = components["schemas"]["RecoveryCodes"];
export type RecoveryCodeStatus = components["schemas"]["RecoveryCodeStatus"];
export const resetReasons = ["forgot_password", "lost_device", "suspected_compromise"] as const satisfies readonly ResetReason[];
export const resetLinkIssuers = ["system_admin"] as const;
export const recoveryApprovers = ["supervisor", "system_admin"] as const;
export const recoveryLimits = { email: 254, code: 64, note: 500 } as const;

/** الرمز الاحتياطي كما يُكتب: تُحذف المسافات والشرطات وتُكبَّر الحروف، ثم قاعدة العقد `^[A-Z2-7]{10,}$`. */
export function normalizeBackupCode(value: string): string | null {
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z2-7]{10,64}$/.test(code) ? code : null;
}
/** للعرض في مجموعات من أربعة («ABCD-EFGH-JKLM»)؛ الشرطة تُحذف عند الإدخال. */
export const groupCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

export function recoveryStartInput(body: Record<string, unknown>): { email: string; backup_code: string } | null {
  if (Object.keys(body).some(key => !["email", "backup_code"].includes(key))) return null;
  const email = typeof body.email === "string" ? body.email.trim() : "", code = typeof body.backup_code === "string" ? normalizeBackupCode(body.backup_code) : null;
  if (!email || email.length > recoveryLimits.email || !/^[^\s@]+@[^\s@]+$/.test(email) || !code) return null;
  return { email, backup_code: code };
}

export function resetLinkInput(body: Record<string, unknown>): { reason: ResetReason } | null {
  if (Object.keys(body).length !== 1 || !(resetReasons as readonly unknown[]).includes(body.reason)) return null;
  return { reason: body.reason as ResetReason };
}

const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** ردّ إصدار الرابط: الرمز إن عاد (لا يعود عند التكرار ولا مع قناة تسليم أخرى) وانتهاؤه، ولا حقل غيرهما. */
export function safeResetLink(value: PasswordResetLink | undefined): PasswordResetLink {
  if (!value || !uuid.test(value.recovery_request_id) || !time(value.reset_token_expires_at)) throw new Error("reset link");
  const token = typeof value.reset_token === "string" && validToken(value.reset_token) ? value.reset_token : undefined;
  return { recovery_request_id: value.recovery_request_id, ...(token ? { reset_token: token } : {}), reset_token_expires_at: value.reset_token_expires_at };
}

/** اعتماد طلب استعادة: كيف تحقّق المعتمِد من الهوية، نص يُدقَّق (1–500 بلا محارف خفية). */
export function approvalInput(body: Record<string, unknown>): { verification_note: string } | null {
  if (Object.keys(body).some(key => key !== "verification_note")) return null;
  const note = typeof body.verification_note === "string" ? cleanText(body.verification_note.replace(/\s+/gu, " ")) : "";
  return validText(note, recoveryLimits.note) ? { verification_note: note } : null;
}
export type ApprovalView = { id: string; reset_token?: string; reset_token_expires_at: string | null };
export function safeApproval(value: components["schemas"]["RecoveryApproval"] | undefined): ApprovalView {
  if (!value || !uuid.test(value.id)) throw new Error("approval");
  const token = typeof value.reset_token === "string" && validToken(value.reset_token) ? value.reset_token : undefined;
  return { id: value.id, ...(token ? { reset_token: token } : {}), reset_token_expires_at: time(value.reset_token_expires_at) ? value.reset_token_expires_at : null };
}

export function safeCodeStatus(value: RecoveryCodeStatus | undefined): RecoveryCodeStatus {
  if (!value || !Number.isSafeInteger(value.remaining) || value.remaining < 0 || value.remaining > 10) throw new Error("codes");
  return { remaining: value.remaining, generated_at: time(value.generated_at) ? value.generated_at : null };
}
export function safeCodes(value: RecoveryCodes | undefined): RecoveryCodes {
  if (!value || !Array.isArray(value.codes) || value.codes.length !== 10 || !value.codes.every(code => typeof code === "string" && /^[A-Z2-7]{12}$/.test(code)) || !time(value.generated_at)) throw new Error("codes");
  return { codes: [...value.codes], generated_at: value.generated_at };
}

/** الرابط الذي يسلّمه المعتمِد: صفحة إعادة التعيين على مصدر الويب نفسه، والرمز في الجزء بعد `#`. */
export const resetLinkFor = (origin: string, locale: string, token: string) => `${origin}/${locale}/reset-password#token=${encodeURIComponent(token)}`;
