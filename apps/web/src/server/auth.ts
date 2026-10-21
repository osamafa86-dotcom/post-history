import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { createApiClient } from "@/generated/client";
import type { Session } from "@/lib/types";
import type { WebConfig } from "./config";
import { WebError } from "./errors";
import type { SessionStore } from "./sessions";

/**
 * عنوان العميل لحدود معدل الدخول عند الخادم: آخر مدخل في X-Forwarded-For الذي تكتبه الحافة، حين يوثق بها
 * (WEB_TRUST_FORWARDED_FOR) وكان عنوانًا صالحًا؛ وإلا لا شيء فيُحسب الحد على عنوان الـBFF نفسه.
 */
export function clientAddress(request: Request, config: WebConfig): string | undefined {
  if (!config.trustForwardedFor) return undefined;
  const last = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  return isIP(last) ? last : undefined;
}

export function upstream(config: WebConfig, token?: string, transport: typeof fetch = fetch, client?: string) {
  return createApiClient({
    baseUrl: config.api, cache: "no-store", redirect: "error",
    // X-Client-Address: يقبلها الخادم من عنوان الـBFF الثابت وحده (BFF_SOURCE_ADDRESSES)
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(client ? { "X-Client-Address": client } : {}) },
    fetch: (request: Request) => {
      if (!["GET", "HEAD"].includes(request.method) && !request.headers.has("Idempotency-Key")) request.headers.set("Idempotency-Key", randomUUID());
      return transport(new Request(request, { signal: AbortSignal.timeout(8000) }));
    },
  });
}
export type Api = ReturnType<typeof upstream>;

export function assertSession(value: Session | undefined): asserts value is Session {
  if (!value?.access_token || !value.refresh_token || !Number.isFinite(Date.parse(value.expires_at)) || Date.parse(value.expires_at) <= Date.now()) {
    throw new WebError(502, "temporarily_unavailable");
  }
}

export async function withSession<T>(id: string, store: SessionStore, config: WebConfig, action: (api: Api) => Promise<T>, transport?: typeof fetch, client?: string): Promise<T> {
  return store.locked(id, async () => {
    const session = await store.read(id);
    if (!session) throw new WebError(401, "session_revoked");
    if (Date.parse(session.tokens.expires_at) < Date.now() + 15000) {
      // يحتفظ الخادم بالزوج الجديد خلف معرّف الكوكي الثابت؛ الطلبات المتزامنة لا تعيد استعمال الرمز القديم.
      try {
        const result = await upstream(config, undefined, transport, client).POST("/auth/refresh", { body: { refresh_token: session.tokens.refresh_token } });
        if (result.response.status === 401) throw new WebError(401, "session_revoked");
        if (!result.response.ok) throw new WebError(503, "temporarily_unavailable");
        assertSession(result.data);
        session.tokens = result.data;
        await store.save(id, session);
      } catch (error) {
        // النتيجة المجهولة للتدوير لا تُعاد: إعادة الرمز قد تُبطل سلسلة صالحة عند الخادم.
        await store.remove(id);
        if (error instanceof WebError && error.status === 401) throw error;
        throw new WebError(401, "session_revoked");
      }
    }
    try { return await action(upstream(config, session.tokens.access_token, transport)); }
    catch (error) {
      if (error instanceof WebError && error.status === 401) await store.remove(id);
      throw error;
    }
  });
}

export function requireOk<T>(result: { data?: T; response: Response }): T {
  if (result.response.status === 401) throw new WebError(401, "session_revoked");
  if (!result.response.ok) throw new WebError([400, 403, 404, 409, 412, 422, 429].includes(result.response.status) ? result.response.status : 503, result.response.status === 412 ? "precondition_failed" : "request_failed");
  return result.data as T;
}
