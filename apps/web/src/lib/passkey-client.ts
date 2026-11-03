import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PasskeyChallenge, WebAuthnCredential } from "./passkey-policy";

/**
 * مراسم WebAuthn في المتصفح (ADR 0108) بمكتبة `@simplewebauthn/browser` بنسخة مثبّتة: الخيارات من الخادم كما هي، والرد `toJSON()` يعود إليه
 * كما هو. الإلغاء من المستخدم أو انتهاء مهلة المتصفح لا يُعرض خطأً؛ والمفتاح المسجّل من قبل (`excludeCredentials`) يُقال باسمه.
 */
export type CeremonyFailure = "cancelled" | "exists" | "failed";
export function ceremonyFailure(error: unknown): CeremonyFailure {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "AbortError") return "cancelled";
  return name === "InvalidStateError" ? "exists" : "failed";
}
export const passkeysSupported = () => typeof window !== "undefined" && browserSupportsWebAuthn();

type AuthenticationOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];
type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
export async function signInCeremony(challenge: PasskeyChallenge): Promise<WebAuthnCredential> {
  return await startAuthentication({ optionsJSON: challenge.public_key as unknown as AuthenticationOptions }) as unknown as WebAuthnCredential;
}
export async function registerCeremony(challenge: PasskeyChallenge): Promise<WebAuthnCredential> {
  return await startRegistration({ optionsJSON: challenge.public_key as unknown as RegistrationOptions }) as unknown as WebAuthnCredential;
}
