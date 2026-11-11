import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * معرّف ترابط الطلب (ADR 0027): يولّده الـBFF لكل طلب يصله، ويرسله إلى الخادم في X-Request-Id مع كل نداء لذلك الطلب،
 * ويعيده في ترويسة رده، فيُتتبَّع الطلب نفسه في سجل الخادم. عشوائي لا يحمل بيانًا، وبالشكل الذي يقبله الخادم
 * من عنوان الـBFF: `[A-Za-z0-9._-]{8,64}`. لا يؤخذ من المتصفح أبدًا.
 */
const current = new AsyncLocalStorage<string>();

export const newRequestId = () => `web-${randomUUID().replaceAll("-", "")}`;

export function withRequestId<T>(id: string, run: () => Promise<T>): Promise<T> {
  return current.run(id, run);
}

/** معرّف الطلب الجاري، أو معرّف جديد لنداء خارج طلب. */
export const requestId = () => current.getStore() ?? newRequestId();
