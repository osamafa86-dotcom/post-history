import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { approvalInput, recoveryApprovers, recoveryStartInput, resetLinkInput, resetLinkIssuers, safeApproval, safeCodes, safeCodeStatus, safeResetLink } from "@/lib/recovery-policy";
import { assertionInput, registrationInput, safeChallenge, safePasskey, safePasskeyList, stepUpInput } from "@/lib/passkey-policy";
import { assertSession, clientAddress, requireOk, upstream, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";
import { validSessionId, type SessionStore } from "./sessions";

/**
 * استعادة الحساب ومفاتيح المرور في الـBFF (ADR 0107، 0108). ما يحمل رده رمزًا أو تحديًا أو رموزًا احتياطية يمرّ مرة إلى المتصفح ولا يُخزَّن
 * ولا يُسجَّل (الرد `no-store`)، وما يكتب موردًا بمفتاح المتصفح نفسه. الرمز وكلمة المرور ورد المصادِق لا تدخل خطأ ولا رسالة.
 */
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });
type Reply = (value: unknown, status?: number) => NextResponse;
type SetCookie = (response: NextResponse, value: string) => void;
/** ردّ الخادم المخالف للعقد لا يصل المتصفح. */
function checked<T>(read: () => T): T { try { return read(); } catch { throw new WebError(502, "temporarily_unavailable"); } }
const passkeysOff = () => new WebError(404, "passkeys_unavailable");

export const publicAccountPaths = ["auth/recovery", "auth/passkeys/login-options", "auth/passkeys/login"];

/** بلا جلسة: بدء الاستعادة برمز احتياطي، وخيارات الدخول بمفتاح المرور، والدخول به (كالدخول بكلمة المرور: كوكي جديد وتُمحى الجلسة السابقة). */
export async function accountPublic(request: Request, path: string, body: Record<string, unknown>, config: WebConfig, store: SessionStore, currentId: string, reply: Reply, setCookie: SetCookie, transport?: typeof fetch) {
  const api = upstream(config, undefined, transport, clientAddress(request, config));
  if (path === "auth/recovery") {
    const input = recoveryStartInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/auth/recovery", { body: input });
    // الردّ نفسه لأي بريد ورمز (العقد): لا يُكشف صحة الرمز ولا وجود الحساب
    if (result.response.status === 202) return reply({ ok: true }, 202);
    if (result.response.status === 429 || result.response.status === 422) throw new WebError(result.response.status, "request_failed");
    throw new WebError(503, "temporarily_unavailable");
  }
  if (path === "auth/passkeys/login-options") {
    if (Object.keys(body).length) throw new WebError(422, "request_failed");
    const result = await api.POST("/auth/passkeys/login-options");
    if (result.response.status === 404) throw passkeysOff();
    if (result.response.status === 429) throw new WebError(429, "request_failed");
    if (!result.response.ok) throw new WebError(503, "temporarily_unavailable");
    return reply(checked(() => safeChallenge(result.data)));
  }
  if (path === "auth/passkeys/login") {
    const input = assertionInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/auth/passkeys/login", { body: input });
    const status = result.response.status;
    if (status === 401) throw new WebError(401, "passkey_failed");
    if (status === 410) throw new WebError(410, "challenge_expired");
    if (status === 404) throw passkeysOff();
    if (status === 429 || status === 422) throw new WebError(status, "request_failed");
    if (!result.response.ok) throw new WebError(503, "temporarily_unavailable");
    assertSession(result.data);
    const id = await store.create(result.data);
    if (validSessionId(currentId)) await store.locked(currentId, () => store.remove(currentId));
    const response = reply({ ok: true });
    setCookie(response, id); return response;
  }
  throw new WebError(404, "request_failed");
}

const resetLinkPath = (path: string) => { const match = /^users\/([^/]+)\/password-reset-links$/.exec(path); return match && uuid.test(match[1]) ? match[1] : null; };
const approvePath = (path: string) => { const match = /^auth\/recovery\/([^/]+)\/approve$/.exec(path); return match && uuid.test(match[1]) ? match[1] : null; };
const passkeyPath = (path: string) => { const match = /^me\/passkeys\/([^/]+)$/.exec(path); return match && uuid.test(match[1]) ? match[1] : null; };

export const accountReadPath = (path: string) => path === "auth/recovery-codes" || path === "me/passkeys";
export function accountWritePath(path: string, method: string) {
  if (method === "POST") return ["auth/recovery-codes", "auth/passkeys/registration-options", "me/passkeys"].includes(path) || !!resetLinkPath(path) || !!approvePath(path);
  return method === "DELETE" && !!passkeyPath(path);
}

export async function accountRead(request: Request, path: string, api: Api) {
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  if (path === "auth/recovery-codes") { const data = requireOk(await api.GET("/auth/recovery-codes")); return json(checked(() => safeCodeStatus(data))); }
  const result = await api.GET("/me/passkeys");
  if (result.response.status === 404) throw passkeysOff();
  const data = requireOk(result);
  return json(checked(() => safePasskeyList(data)));
}

function idempotency(request: Request) {
  const key = request.headers.get("Idempotency-Key");
  if (!key || !uuid.test(key)) throw new WebError(400, "request_failed");
  return { "Idempotency-Key": key };
}

/**
 * الكتابات بجلسة. المستدعي معروف قبلها (`GET /auth/me` في المعالج)، فـ`401` من إعادة التحقق قبل تسجيل المفتاح وقبل توليد الرموز
 * الاحتياطية (ADR 0117) كلمة مرور أو رمز خاطئ لا جلسة منتهية: يعود `422` برمزه كي لا يُخرَج المستخدم ولا تُمحى جلسته.
 */
const stepUpRefused = (code: string | undefined) => new WebError(422, code === "totp_required" ? "totp_required" : "step_up_failed");
export async function accountWrite(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>) {
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  if (path === "auth/recovery-codes") {
    // كلمة المرور ورمز TOTP وحدهما، بقاعدة العقد قبل الإرسال؛ الجسم الناقص لا يصل الخادم فلا يُعدّ فشلًا على الحساب
    const input = stepUpInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/auth/recovery-codes", { body: input });
    if (result.response.status === 401) throw stepUpRefused(result.error?.code);
    const data = requireOk(result);
    return json(checked(() => safeCodes(data)));
  }
  if (path === "auth/passkeys/registration-options") {
    const input = stepUpInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/auth/passkeys/registration-options", { body: input });
    const status = result.response.status, code = result.error?.code;
    if (status === 401) throw stepUpRefused(code);
    if (status === 404) throw passkeysOff();
    if (status === 409) throw new WebError(409, code === "passkey_limit_reached" ? code : "request_failed");
    const data = requireOk(result);
    return json(checked(() => safeChallenge(data)));
  }
  if (path === "me/passkeys") {
    const input = registrationInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/me/passkeys", { params: { header: idempotency(request) }, body: input });
    const status = result.response.status, code = result.error?.code;
    if (status === 410) throw new WebError(410, "challenge_expired");
    if (status === 409) throw new WebError(409, code === "passkey_exists" || code === "passkey_limit_reached" ? code : "request_failed");
    if (status === 422) throw new WebError(422, "passkey_rejected");
    if (status === 404) throw passkeysOff();
    const data = requireOk(result);
    return json(checked(() => safePasskey(data)), 201);
  }
  const passkey = passkeyPath(path);
  if (passkey) {
    if (Object.keys(body).length) throw new WebError(422, "request_failed");
    requireOk(await api.DELETE("/me/passkeys/{passkey_id}", { params: { path: { passkey_id: passkey }, header: idempotency(request) } }));
    return new NextResponse(null, { status: 204, headers: privateHeaders });
  }
  const target = resetLinkPath(path);
  if (target) {
    if (!hasRole(me, ...resetLinkIssuers) || target === me.user_id) throw new WebError(403, "request_failed");
    const input = resetLinkInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/users/{id}/password-reset-links", { params: { path: { id: target }, header: idempotency(request) }, body: input });
    if (result.response.status === 403) throw new WebError(403, result.error?.code === "admin_quorum_required" ? "admin_quorum_required" : "request_failed");
    const data = requireOk(result);
    return json(checked(() => safeResetLink(data)), 201);
  }
  const request_ = approvePath(path);
  if (request_) {
    if (!hasRole(me, ...recoveryApprovers)) throw new WebError(403, "request_failed");
    const input = approvalInput(body);
    if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/auth/recovery/{id}/approve", { params: { path: { id: request_ } }, body: input });
    if (result.response.status === 403) throw new WebError(403, result.error?.code === "admin_quorum_required" ? "admin_quorum_required" : "request_failed");
    const data = requireOk(result);
    return json(checked(() => safeApproval(data)));
  }
  throw new WebError(404, "request_failed");
}
