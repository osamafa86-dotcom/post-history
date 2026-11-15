import { createApiClient } from "@/generated/client";
import type { Locale } from "./i18n";
import { clearUploads } from "./upload-store";
import { returnPath } from "./return-path";

let departing = false;

export class RequestError extends Error {
  constructor(readonly status: number) { super("Request failed"); }
}
export function browserApi() {
  return createApiClient({ baseUrl: `${window.location.origin}/api/bff`, credentials: "same-origin", cache: "no-store", redirect: "error",
    fetch: (request: Request) => {
      if (!["GET", "HEAD"].includes(request.method)) {
        request.headers.set("X-Requested-With", "post-history-web");
        request.headers.set("Content-Type", "application/json");
        if (!request.body) request = new Request(request, { body: "{}" });
      }
      return fetch(request);
    },
  });
}
export function dataOrThrow<T>(result: { data?: T; response: Response }): T {
  if (result.response.status === 401 && !departing) window.dispatchEvent(new Event("session-revoked"));
  if (!result.response.ok || result.data === undefined) throw new RequestError(result.response.status);
  return result.data;
}
export async function authPost(path: "login" | "logout", body: unknown) {
  const response = await fetch(`/api/bff/auth/${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) });
  return { response, body: await response.json() as { ok?: boolean; code?: string; details?: { retry_after_seconds?: unknown } } };
}
/** طلب بلا جلسة إلى الـBFF (بدء الاستعادة برمز احتياطي، والدخول بمفتاح المرور): الحالة والجسم، ولا يُعلَن به انتهاء جلسة. */
export async function publicPost<T extends object = Record<string, never>>(path: "auth/recovery" | "auth/passkeys/login-options" | "auth/passkeys/login", body: unknown) {
  const response = await fetch(`/api/bff/${path}`, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "Content-Type": "application/json", "X-Requested-With": "post-history-web" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as Partial<T> & { code?: string } };
}
/**
 * مغادرة الجلسة إلى صفحة الدخول: `revoked` جلسة أُبطلت أو انتهت، `signed-out` خروج باختيار صاحبها، `none` زائر بلا جلسة (فلا يُقال له
 * «أُبطلت الجلسة»). من انتهت جلسته وسط العمل أو فتح رابطًا عميقًا بلا جلسة يعود إلى صفحته بعد الدخول (`next`، مسار داخلي وحده)؛ والخارج
 * باختياره لا يُعاد. الوارد هو المدخل العام (جذر الموقع يحيل إليه)، فلا يُحفظ: صاحبه يذهب إلى صفحة دوره.
 */
export function leaveSession(locale: Locale, reason: "revoked" | "signed-out" | "none", broadcast = true) {
  // رسالة القناة تصل إلى نسخة أخرى منها في التبويب نفسه؛ لا تغيّر سبب الخروج الذي تأكد بالفعل.
  if (departing) return;
  departing = true;
  window.dispatchEvent(new Event("clear-private-state"));
  // سجل استئناف الرفع يُمحى مع الخروج وإن لم تكن صفحة الرفع مفتوحة (حاسوب مشترك، نموذج التهديد S10).
  clearUploads();
  // التبويبات الأخرى تعرف السبب: الخارج باختياره يخرج فيها بالرسالة نفسها، وغيره تتحقق كل واحدة من جلستها.
  if (broadcast && "BroadcastChannel" in window) { const channel = new BroadcastChannel("web-session"); channel.postMessage(reason === "signed-out" ? "signed-out" : "session-ended"); channel.close(); }
  const here = window.location.pathname + window.location.search;
  const next = reason === "signed-out" || /^\/(ar|en)\/inbox$/.test(here) ? null : returnPath(here, window.location.origin);
  const query = new URLSearchParams({ ...(reason === "none" ? {} : { reason }), ...(next ? { next } : {}) }).toString();
  window.location.replace(`/${locale}/login${query ? `?${query}` : ""}`);
}
