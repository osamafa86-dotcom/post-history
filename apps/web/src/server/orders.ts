import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { allowedCheckout, orderCreate, orderReaders, orderStatuses, orderWriters, safeOrder } from "@/lib/order-policy";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

/** قراءة الطلبات (#203 بند 30): نطاق المشتري مؤسسته في الخادم؛ الطاقم يصفّي بالمؤسسة. */
export async function orderRead(request: Request, id: string | undefined, api: Api, me: Me) {
  if (!hasRole(me, ...orderReaders)) throw new WebError(403, "request_failed");
  const search = new URL(request.url).searchParams;
  if (id) {
    if (!uuid.test(id) || search.size) throw new WebError(404, "request_failed");
    return json(safeOrder(requireOk(await api.GET("/orders/{order_id}", { params: { path: { order_id: id } } }))));
  }
  if ([...search.keys()].some(key => !["status", "organization_id", "cursor", "limit"].includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed");
  const status = search.get("status"), org = search.get("organization_id"), limit = search.get("limit") ?? "50", cursor = search.get("cursor");
  if ((status && !(orderStatuses as readonly string[]).includes(status)) || (org && !uuid.test(org)) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
  const page = requireOk(await api.GET("/orders", { params: { query: { limit: +limit, ...(status ? { status: status as typeof orderStatuses[number] } : {}), ...(org ? { organization_id: org } : {}), ...(cursor ? { cursor } : {}) } } }));
  return json({ items: page.items.map(safeOrder), next_cursor: page.next_cursor });
}

/** الكتابة للمشترين وحدهم: إنشاء الطلب من السلة، وجلسة الدفع المستضافة، والإلغاء. */
export async function orderWrite(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }, config: WebConfig) {
  if (!hasRole(me, ...orderWriters)) throw new WebError(403, "request_failed");
  if (path === "orders" && request.method === "POST") {
    const input = orderCreate(body); if (!input) throw new WebError(422, "request_failed");
    return json(safeOrder(requireOk(await api.POST("/orders", { params: { header }, body: input }))), 201);
  }
  const action = /^orders\/([^/]+)\/(checkout|cancel)$/.exec(path);
  if (!action || !uuid.test(action[1]) || request.method !== "POST" || Object.keys(body).length) throw new WebError(action ? 422 : 405, "request_failed");
  const params = { path: { order_id: action[1] }, header };
  if (action[2] === "cancel") return json(safeOrder(requireOk(await api.POST("/orders/{order_id}/cancel", { params }))));
  const session = requireOk(await api.POST("/orders/{order_id}/checkout", { params }));
  // الرابط يذهب إلى المتصفح ليُوجَّه إليه؛ لا إلى أصل خارج قائمة الإعداد، ولا يُسجَّل.
  if (!allowedCheckout(session.checkout_url, config.checkoutOrigins ?? [])) throw new WebError(502, "temporarily_unavailable");
  return json({ checkout_url: session.checkout_url, provider: session.provider, expires_at: session.expires_at });
}
