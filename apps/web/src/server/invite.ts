import type { NextResponse } from "next/server";
import type { components } from "@/generated/schema";
import { assertSession, clientAddress, upstream, withSession } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";
import { validSessionId, type SessionStore } from "./sessions";
import { inviteInput, safeEnrollment, totpInput } from "@/lib/invite-policy";

type Reply = (value: unknown, status?: number) => NextResponse;
type SetCookie = (response: NextResponse, value: string) => void;

/**
 * قبول الدعوة (S5): رمز الدعوة يُسلَّم كرمز الاستعادة، فالخطوة الأولى `POST /auth/recovery/complete` بلا جلسة. الردّ جلسة مقيّدة تُحفظ خلف
 * كوكي الجلسة نفسه (لا تصل رموزها إلى المتصفح)، وبيانات ربط TOTP تُعرض مرة واحدة ولا تُسجَّل. الرمز وكلمة المرور لا يدخلان سجلًا ولا خطأ.
 * أي رفض للرمز (مجهول أو منتهٍ أو مستهلك) `401` واحد بلا تفريق (`invite_invalid`)، كما يردّه العقد.
 */
export async function completeInvite(request: Request, body: Record<string, unknown>, config: WebConfig, store: SessionStore, currentId: string, reply: Reply, setCookie: SetCookie, transport?: typeof fetch) {
  const input = inviteInput(body);
  if (!input) throw new WebError(422, "request_failed");
  const result = await upstream(config, undefined, transport, clientAddress(request, config)).POST("/auth/recovery/complete", { body: input });
  if (result.response.status === 401) throw new WebError(401, "invite_invalid");
  if (result.response.status === 429) throw new WebError(429, "request_failed");
  if (result.response.status === 422) throw new WebError(422, "request_failed");
  if (!result.response.ok || !result.data) throw new WebError(503, "temporarily_unavailable");
  const completion = result.data as components["schemas"]["RecoveryCompletion"];
  assertSession(completion.session);
  const enrollment = safeEnrollment(completion.totp_enrollment);
  if (!enrollment) throw new WebError(503, "temporarily_unavailable");
  const id = await store.create(completion.session);
  if (validSessionId(currentId)) await store.locked(currentId, () => store.remove(currentId));
  const response = reply({ totp_enrollment: enrollment });
  setCookie(response, id); return response;
}

/**
 * الخطوة الثانية: `POST /auth/totp/confirm` بالجلسة المقيّدة، فيردّ الخادم جلسة كاملة جديدة تحلّ محلّها. يُدوَّر معرّف الكوكي عندها (كالدخول)،
 * وتُمحى الجلسة المقيّدة. الرمز الخطأ `401 totp_invalid` ويبقى المدعو على الخطوة نفسها بجلسته المقيّدة.
 */
export async function confirmInvite(body: Record<string, unknown>, config: WebConfig, store: SessionStore, id: string, reply: Reply, setCookie: SetCookie, transport?: typeof fetch) {
  const input = totpInput(body);
  if (!input) throw new WebError(422, "request_failed");
  if (!validSessionId(id)) throw new WebError(401, "session_revoked");
  const result = await withSession(id, store, config, api => api.POST("/auth/totp/confirm", { body: input }), transport);
  if (result.response.status === 401) throw new WebError(401, "totp_invalid");
  if (result.response.status === 429 || result.response.status === 409) throw new WebError(result.response.status, "request_failed");
  if (!result.response.ok) throw new WebError(503, "temporarily_unavailable");
  assertSession(result.data);
  const next = await store.create(result.data);
  await store.locked(id, () => store.remove(id));
  const response = reply({ ok: true });
  setCookie(response, next); return response;
}
