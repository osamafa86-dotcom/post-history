// استعادة الحساب ومفاتيح المرور لخادم الاختبار (ADR 0107، 0108): رموز احتياطية وتحديات ومفاتيح ورموز إعادة تعيين متخيَّلة منخفضة
// الإنتروبيا، وحقول زائدة («never-display-canary») ليثبت الاختبار أن الـBFF يقصّها. لا تحقق تشفيري: المراسم في المتصفح مُحاكاة في الاختبار،
// والتحقق الحقيقي في الخادم (`apps/api`) بمكتبته. للاختبار والقياس المحلي فقط؛ لا يدخل حزمة التطبيق.
import { randomUUID } from "node:crypto";
import type { Me } from "../src/lib/types";
import { staffAccount } from "./fixture-admin";

type Reply = { status: number; value: unknown; replay?: unknown } | null;
type Key = { id: string; credential: string; owner: Me; name: string | null; multi_device: boolean; created_at: string; last_used_at: string | null };
const passkeys: Key[] = [], challenges = new Map<string, { owner: Me | null; kind: "register" | "login"; expires: number }>();
const codes = new Map<string, { remaining: number; generated_at: string }>(), stepUpFailures = new Map<string, number>();
const requests = new Map<string, { state: "pending_approval" | "approved"; created_at: string; admin: boolean }>();
const resetTokens = new Set<string>();
let issued = 0, recoveryStarts = 0, passkeysOff = false;
export const recoveryRequestId = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const resetTokenPrefix = "synthetic-reset-token-";
/** معرّف المفتاح المزروع (base64url لـ«seeded-passkey»)؛ الاختبار يحاكي به جهازًا يحمله. */
export const seededDevice = "c2VlZGVkLXBhc3NrZXk";
const has = (user: Me, ...roles: string[]) => user.roles.some(role => roles.includes(role.name));
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const b64url = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,1366}$/.test(value);

export function resetAuth(owner: Me) {
  challenges.clear(); codes.clear(); stepUpFailures.clear(); requests.clear(); resetTokens.clear(); issued = 0; recoveryStarts = 0; passkeysOff = false;
  passkeys.splice(0, passkeys.length, { id: "80000000-0000-4000-8000-000000000001", credential: seededDevice, owner, name: "حاسوب المكتب", multi_device: true, created_at: "2026-10-20T09:00:00Z", last_used_at: "2026-10-21T08:30:00Z" });
  requests.set(recoveryRequestId(1), { state: "pending_approval", created_at: "2026-10-21T10:00:00Z", admin: false });
  requests.set(recoveryRequestId(2), { state: "pending_approval", created_at: "2026-10-21T10:00:00Z", admin: true });
}
export const authState = () => ({ passkeys: passkeys.length, recoveryStarts, requests: Object.fromEntries([...requests].map(([id, r]) => [id, r.state])) });
export function setPasskeysOff(off: boolean) { passkeysOff = off; }
/** رمز إعادة تعيين صادر لم يُستهلك، ويُستهلك مرة واحدة. */
export const resetTokenKnown = (token: string) => resetTokens.has(token);
export function consumeResetToken(token: string) { return resetTokens.delete(token); }

function challenge(owner: Me | null, kind: "register" | "login") {
  const id = randomUUID(), expires = Date.now() + 300000;
  challenges.set(id, { owner, kind, expires });
  const mine = owner ? passkeys.filter(key => key.owner.user_id === owner.user_id) : [];
  const public_key = kind === "register"
    ? { challenge: "c3ludGhldGljLWNoYWxsZW5nZQ", rp: { name: "Synthetic" }, user: { id: "c3ludGhldGljLXVzZXI", name: "synthetic", displayName: "synthetic" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], timeout: 60000, attestation: "none", excludeCredentials: mine.map(key => ({ id: key.credential, type: "public-key" })), authenticatorSelection: { residentKey: "required", userVerification: "preferred" } }
    : { challenge: "c3ludGhldGljLWNoYWxsZW5nZQ", timeout: 60000, userVerification: "preferred", allowCredentials: [] };
  return { challenge_id: id, public_key, expires_at: new Date(expires).toISOString(), internal_note: "never-display-canary" };
}
function take(id: unknown, kind: "register" | "login") {
  const found = typeof id === "string" ? challenges.get(id) : undefined;
  if (!found || found.kind !== kind) return null;
  challenges.delete(id as string);
  return found.expires > Date.now() ? found : null;
}
const view = (key: Key) => ({ id: key.id, name: key.name, multi_device: key.multi_device, created_at: key.created_at, last_used_at: key.last_used_at, credential_id: key.credential });

/** بلا جلسة: بدء الاستعادة (الرد واحد لأي بريد ورمز)، وخيارات الدخول بمفتاح المرور، والدخول به. */
export function authPublic(path: string, method: string, body: Record<string, unknown>, signIn: (owner: Me) => unknown): Reply {
  if (method !== "POST") return null;
  if (path === "/v1/auth/recovery") {
    if (typeof body.email !== "string" || typeof body.backup_code !== "string" || !/^[A-Z2-7]{10,}$/.test(body.backup_code)) return { status: 422, value: { code: "validation_failed" } };
    recoveryStarts++; return { status: 202, value: { message: "never-display-canary" } };
  }
  if (path === "/v1/auth/passkeys/login-options") return passkeysOff ? { status: 404, value: {} } : { status: 200, value: challenge(null, "login") };
  if (path === "/v1/auth/passkeys/login") {
    if (passkeysOff) return { status: 404, value: {} };
    const credential = body.credential as { id?: unknown } | undefined;
    if (!take(body.challenge_id, "login")) return { status: 410, value: { code: "challenge_expired" } };
    const key = passkeys.find(item => item.credential === credential?.id);
    if (!key) return { status: 401, value: { code: "unauthorized" } };
    key.last_used_at = new Date().toISOString();
    return { status: 200, value: signIn(key.owner) };
  }
  return null;
}

/** بجلسة: الرموز الاحتياطية، ومفاتيح المرور، ورابط إعادة التعيين، واعتماد الاستعادة. `replay` ما يعود عند التكرار بالمفتاح نفسه. */
export function authRead(path: string, user: Me): Reply {
  if (path === "/v1/auth/recovery-codes") return { status: 200, value: { remaining: codes.get(user.user_id)?.remaining ?? 0, generated_at: codes.get(user.user_id)?.generated_at ?? null, internal_note: "never-display-canary" } };
  if (path === "/v1/me/passkeys") return passkeysOff ? { status: 404, value: {} } : { status: 200, value: { items: passkeys.filter(key => key.owner.user_id === user.user_id).map(view) } };
  return null;
}
/**
 * إعادة التحقق قبل تسجيل مفتاح المرور وقبل توليد الرموز الاحتياطية (ADR 0117) كالخادم: الجسم الغائب وكلمة المرور الخاطئة `401`،
 * والجسم بحقل زائد `422`، وغياب الرمز بعد كلمة مرور صحيحة `401 totp_required`. الفشل يُعدّ لكل حساب في عدّاد واحد للطريقين، وبعد خمس
 * محاولات فاشلة `429` حتى إعادة الضبط (الخادم يؤخّر بتضاعف؛ هنا حدّ ثابت يكفي الاختبار)، والنجاح ينسى العدّاد.
 */
function stepUp(user: Me, body: Record<string, unknown>): Reply {
  if (Object.keys(body).some(key => !["password", "totp_code"].includes(key))) return { status: 422, value: { code: "validation_failed" } };
  if ((stepUpFailures.get(user.user_id) ?? 0) >= 5) return { status: 429, value: { code: "rate_limited" } };
  const fail = (code: string): Reply => { stepUpFailures.set(user.user_id, (stepUpFailures.get(user.user_id) ?? 0) + 1); return { status: 401, value: { code } }; };
  if (body.password !== "synthetic-password") return fail("unauthorized");
  if (user.totp_enabled && body.totp_code === undefined) return fail("totp_required");
  if (user.totp_enabled && body.totp_code !== "123456") return fail("unauthorized");
  stepUpFailures.delete(user.user_id); return null;
}

export function authWrite(path: string, method: string, user: Me, body: Record<string, unknown>): Reply {
  if (path === "/v1/auth/recovery-codes" && method === "POST") {
    const refused = stepUp(user, body);
    if (refused) return refused;
    const generated_at = new Date().toISOString();
    codes.set(user.user_id, { remaining: 10, generated_at });
    // رموز متخيَّلة بنمط العقد `^[A-Z2-7]{12}$`
    return { status: 201, value: { codes: Array.from({ length: 10 }, (_, i) => `SYNTHETICOD${"ABCDEFGHJK"[i]}`), generated_at } };
  }
  if (path === "/v1/auth/passkeys/registration-options" && method === "POST") {
    if (passkeysOff) return { status: 404, value: {} };
    const refused = stepUp(user, body);
    if (refused) return refused;
    if (passkeys.filter(key => key.owner.user_id === user.user_id).length >= 10) return { status: 409, value: { code: "passkey_limit_reached" } };
    return { status: 200, value: challenge(user, "register") };
  }
  if (path === "/v1/me/passkeys" && method === "POST") {
    const credential = body.credential as { id?: unknown } | undefined, found = take(body.challenge_id, "register");
    if (!found || found.owner?.user_id !== user.user_id) return { status: 410, value: { code: "challenge_expired" } };
    if (!b64url(credential?.id)) return { status: 422, value: { code: "validation_failed" } };
    if (passkeys.some(key => key.credential === credential!.id)) return { status: 409, value: { code: "passkey_exists" } };
    const key: Key = { id: randomUUID(), credential: String(credential!.id), owner: user, name: typeof body.name === "string" ? body.name : null, multi_device: false, created_at: new Date().toISOString(), last_used_at: null };
    passkeys.push(key); return { status: 201, value: view(key) };
  }
  const passkey = /^\/v1\/me\/passkeys\/([^/]+)$/.exec(path);
  if (passkey && method === "DELETE") {
    const index = passkeys.findIndex(key => key.id === passkey[1] && key.owner.user_id === user.user_id);
    if (index < 0) return { status: 404, value: {} };
    passkeys.splice(index, 1); return { status: 204, value: null };
  }
  const link = /^\/v1\/users\/([^/]+)\/password-reset-links$/.exec(path);
  if (link && method === "POST") {
    if (!has(user, "system_admin") || link[1] === user.user_id) return { status: 403, value: { code: "forbidden_scope" } };
    const row = staffAccount(link[1]);
    if (!row) return { status: 404, value: {} };
    if (row.roles.includes("system_admin")) return { status: 403, value: { code: "admin_quorum_required" } };
    if (row.status === "suspended") return { status: 409, value: { code: "recovery_state_conflict" } };
    if (!["forgot_password", "lost_device", "suspected_compromise"].includes(String(body.reason))) return { status: 422, value: { code: "validation_failed" } };
    row.status = "recovery";
    const token = `${resetTokenPrefix}${String(++issued).padStart(12, "0")}`, value = { recovery_request_id: randomUUID(), reset_token: token, reset_token_expires_at: later(3600000) };
    resetTokens.add(token);
    return { status: 201, value, replay: { recovery_request_id: value.recovery_request_id, reset_token_expires_at: value.reset_token_expires_at } };
  }
  const approve = /^\/v1\/auth\/recovery\/([^/]+)\/approve$/.exec(path);
  if (approve && method === "POST") {
    if (!has(user, "supervisor", "system_admin")) return { status: 403, value: { code: "forbidden_scope" } };
    const request = requests.get(approve[1]);
    if (!request) return { status: 404, value: {} };
    if (request.admin) return { status: 403, value: { code: "admin_quorum_required" } };
    if (request.state !== "pending_approval") return { status: 409, value: { code: "recovery_state_conflict" } };
    if (typeof body.verification_note !== "string" || !body.verification_note.trim()) return { status: 422, value: { code: "validation_failed" } };
    request.state = "approved";
    const token = `${resetTokenPrefix}${String(++issued).padStart(12, "0")}`;
    resetTokens.add(token);
    return { status: 200, value: { id: approve[1], state: "approved", created_at: request.created_at, reset_token: token, reset_token_expires_at: later(86400000) } };
  }
  return null;
}
