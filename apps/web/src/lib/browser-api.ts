import { createApiClient } from "@/generated/client";
import type { Locale } from "./i18n";
import { clearUploads } from "./upload-store";

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
  return { response, body: await response.json() as { ok?: boolean; code?: string } };
}
export function leaveSession(locale: Locale, reason: "revoked" | "signed-out", broadcast = true) {
  // رسالة القناة تصل إلى نسخة أخرى منها في التبويب نفسه؛ لا تغيّر سبب الخروج الذي تأكد بالفعل.
  if (departing) return;
  departing = true;
  window.dispatchEvent(new Event("clear-private-state"));
  // سجل استئناف الرفع يُمحى مع الخروج وإن لم تكن صفحة الرفع مفتوحة (حاسوب مشترك، نموذج التهديد S10).
  clearUploads();
  if (broadcast && "BroadcastChannel" in window) { const channel = new BroadcastChannel("web-session"); channel.postMessage("signed-out"); channel.close(); }
  window.location.replace(`/${locale}/login?reason=${reason}`);
}
