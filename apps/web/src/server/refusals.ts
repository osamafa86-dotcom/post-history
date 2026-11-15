import { refusalOf } from "@/lib/refusal-policy";
import { requireOk } from "./auth";
import { WebError } from "./errors";

/** كـ`requireOk`، لكن رفض الخادم الذي في القائمة البيضاء يمرّ برمزه (والشروط الفاشلة للإدراج بأسمائها)، بلا رسالة الخادم. */
export function refusalOk<T>(result: { data?: T; error?: unknown; response: Response }, options: { listing?: boolean } = {}): T {
  const refusal = refusalOf(result.response.status, result.error, options);
  if (refusal) throw new WebError(result.response.status, refusal.code, refusal.failed ? { failed: refusal.failed } : undefined);
  return requireOk(result);
}
