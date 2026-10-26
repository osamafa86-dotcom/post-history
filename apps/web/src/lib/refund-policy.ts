import type { components } from "@/generated/schema";
import { uuid } from "./query";
import type { Order } from "./order-policy";

// الاستردادات ببنودها (v0.3، ADR 0025 الجزء 5)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type Refund = components["schemas"]["Refund"];
export type RefundCreate = components["schemas"]["RefundCreate"];
type Role = components["schemas"]["RoleName"];
export const refundReaders = ["system_admin", "finance", "buyer_admin"] as const satisfies readonly Role[];
export const refundWriters = ["system_admin", "finance"] as const satisfies readonly Role[];
export const refundReasons = ["buyer_request", "duplicate", "rights_withdrawn", "dispute", "exclusivity_lost", "other"] as const satisfies readonly components["schemas"]["RefundReason"][];
export const refundStatuses = ["pending", "succeeded", "failed"] as const satisfies readonly Refund["status"][];
export const refundLimits = { items: 20 } as const;

/** طلب استرداد بقواعد العقد، أو null: بنود فريدة بلا مبلغ حر، وسبب مرمّز بلا نص. */
export function refundCreate(body: Record<string, unknown>): RefundCreate | null {
  if (Object.keys(body).sort().join() !== "order_item_ids,reason_code") return null;
  const ids = body.order_item_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > refundLimits.items || new Set(ids).size !== ids.length || !ids.every(id => typeof id === "string" && uuid.test(id))) return null;
  if (!(refundReasons as readonly unknown[]).includes(body.reason_code)) return null;
  return { order_item_ids: [...ids] as string[], reason_code: body.reason_code as RefundCreate["reason_code"] };
}
/** الاسترداد للمتصفح بقائمة بيضاء. */
export function safeRefund(r: Refund): Refund {
  return { id: r.id, order_id: r.order_id, order_item_ids: [...r.order_item_ids], amount: { amount_minor: r.amount.amount_minor, currency: r.amount.currency }, reason_code: r.reason_code, status: r.status, created_by: r.created_by, created_at: r.created_at, completed_at: r.completed_at ?? null };
}
/** البنود المتاحة للاسترداد: كل بنود الطلب المدفوع عدا ما في استرداد معلّق أو ناجح (الفاشل يحررها). */
export function refundable(order: Order, refunds: Refund[]) {
  if (order.status !== "paid") return [];
  const held = new Set(refunds.filter(r => r.status !== "failed").flatMap(r => r.order_item_ids));
  return order.items.filter(item => !held.has(item.id));
}
