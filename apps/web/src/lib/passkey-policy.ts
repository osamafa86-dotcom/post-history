import type { components } from "@/generated/schema";
import { validText } from "./admin-text";
import { uuid } from "./query";

/**
 * مفاتيح المرور (WebAuthn، ADR 0107، 0108) بقواعد العقد. خيارات WebAuthn ورد المتصفح كائنان مفتوحان يمرّان كما هما بين المتصفح والخادم، فلا
 * يفسّرهما الويب؛ يفحص شكلهما وحجمهما وحده، والخادم يتحقق بمكتبته. لا يُعرض للمستخدم معرّف الاعتماد ولا التحدي.
 */
export type Passkey = components["schemas"]["Passkey"];
export type PasskeyChallenge = components["schemas"]["PasskeyChallenge"];
export type WebAuthnCredential = components["schemas"]["WebAuthnCredential"];
export const passkeyLimits = { name: 40, max: 10, password: 256, credential: 49152 } as const;

const b64url = (value: unknown, max: number) => typeof value === "string" && value.length >= 1 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

/** إعادة التحقق قبل التسجيل: كلمة المرور، ورمز TOTP إن وُجد. */
export function stepUpInput(body: Record<string, unknown>): { password: string; totp_code?: string } | null {
  if (Object.keys(body).some(key => !["password", "totp_code"].includes(key))) return null;
  const { password, totp_code: code } = body;
  if (typeof password !== "string" || password.length < 8 || password.length > passkeyLimits.password) return null;
  if (code !== undefined && (typeof code !== "string" || !/^[0-9]{6}$/.test(code))) return null;
  return { password, ...(code ? { totp_code: code as string } : {}) };
}

/** ردّ المتصفح (`toJSON()`): المعرّفان base64url والنوع والاستجابة كائنًا، بحدود العقد؛ وما عداها يمرّ كما هو. */
export function validCredential(value: unknown): value is WebAuthnCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (!b64url(c.id, 1366) || !b64url(c.rawId, 1366) || typeof c.type !== "string" || c.type.length > 32) return false;
  if (!c.response || typeof c.response !== "object" || Array.isArray(c.response)) return false;
  const r = c.response as Record<string, unknown>, sizes: Record<string, number> = { clientDataJSON: 8192, attestationObject: 32768, authenticatorData: 8192, signature: 8192 };
  for (const [key, max] of Object.entries(sizes)) if (r[key] !== undefined && !b64url(r[key], max)) return false;
  if (r.userHandle !== undefined && r.userHandle !== null && !b64url(r.userHandle, 128)) return false;
  return JSON.stringify(value).length <= passkeyLimits.credential;
}

export const validPasskeyName = (value: unknown): value is string => validText(value, passkeyLimits.name);

export function registrationInput(body: Record<string, unknown>): components["schemas"]["PasskeyRegistration"] | null {
  if (Object.keys(body).some(key => !["challenge_id", "credential", "name"].includes(key))) return null;
  if (typeof body.challenge_id !== "string" || !uuid.test(body.challenge_id) || !validCredential(body.credential)) return null;
  if (body.name !== undefined && !validPasskeyName(body.name)) return null;
  return { challenge_id: body.challenge_id, credential: body.credential, ...(body.name !== undefined ? { name: body.name as string } : {}) };
}
export function assertionInput(body: Record<string, unknown>): components["schemas"]["PasskeyAssertion"] | null {
  if (Object.keys(body).some(key => !["challenge_id", "credential"].includes(key))) return null;
  if (typeof body.challenge_id !== "string" || !uuid.test(body.challenge_id) || !validCredential(body.credential)) return null;
  return { challenge_id: body.challenge_id, credential: body.credential };
}

/** التحدي وخياراته للمتصفح كما هي، بحدّ حجم؛ ما يخالف العقد لا يصل المتصفح. */
export function safeChallenge(value: PasskeyChallenge | undefined): PasskeyChallenge {
  if (!value || !uuid.test(value.challenge_id) || !value.public_key || typeof value.public_key !== "object" || Array.isArray(value.public_key)) throw new Error("challenge");
  if (typeof value.public_key.challenge !== "string" || !Number.isFinite(Date.parse(value.expires_at)) || JSON.stringify(value.public_key).length > 16384) throw new Error("challenge");
  return { challenge_id: value.challenge_id, public_key: value.public_key, expires_at: value.expires_at };
}

const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
export function safePasskey(value: Passkey): Passkey {
  if (!uuid.test(value.id) || !time(value.created_at)) throw new Error("passkey");
  return { id: value.id, name: validPasskeyName(value.name) ? value.name : null, multi_device: value.multi_device === true, created_at: value.created_at, last_used_at: time(value.last_used_at) ? value.last_used_at : null };
}
export function safePasskeyList(value: components["schemas"]["PasskeyList"] | undefined): { items: Passkey[] } {
  if (!value || !Array.isArray(value.items)) throw new Error("passkeys");
  return { items: value.items.slice(0, passkeyLimits.max).map(safePasskey) };
}
