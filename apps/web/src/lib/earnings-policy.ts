import type { components } from "@/generated/schema";
import { currencies } from "./license-policy";

// الأرباح والصرف التجريبي (v0.3، ADR 0033، #359)؛ يطابقها contract-drift مع OpenAPI، وليست نماذج بديلة.
export type EarningsSummary = components["schemas"]["EarningsSummary"];
export type EarningsEntry = components["schemas"]["EarningsEntry"];
export type PayoutRequest = components["schemas"]["PayoutRequest"];
export type PayoutRequestCreate = components["schemas"]["PayoutRequestCreate"];
export type PayoutReject = components["schemas"]["PayoutReject"];
export type PayoutPolicy = components["schemas"]["PayoutPolicy"];
export type PayoutPolicyInput = components["schemas"]["PayoutPolicyInput"];
type Role = components["schemas"]["RoleName"];
type Currency = components["schemas"]["Currency"];
export const earnerRoles = ["reporter"] as const satisfies readonly Role[];
export const payoutStaff = ["system_admin", "finance"] as const satisfies readonly Role[];
export const policyWriters = ["system_admin"] as const satisfies readonly Role[];
export const payableStates = ["pending", "available", "in_payout", "paid"] as const satisfies readonly components["schemas"]["PayableState"][];
export const payoutStates = ["requested", "approved", "processing", "paid", "failed", "rejected", "cancelled"] as const satisfies readonly PayoutRequest["state"][];
export const payoutReasons = ["documents_missing", "suspected_fraud", "policy", "channel_failed", "other"] as const satisfies readonly PayoutReject["reason_code"][];
export const entryKinds = ["sale", "refund", "release", "payout", "correction"] as const satisfies readonly EarningsEntry["kind"][];
export const payoutChannels = ["sandbox"] as const satisfies readonly PayoutRequestCreate["channel"][];
export const earningsLimits = { amountMax: 100000000000, reserveMax: 5000 } as const;

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const money = (value: unknown, currency?: Currency): value is { amount_minor: number; currency: Currency } =>
  plain(value) && Object.keys(value).sort().join() === "amount_minor,currency" && Number.isSafeInteger(value.amount_minor) && (value.amount_minor as number) >= 0 && (value.amount_minor as number) <= earningsLimits.amountMax
  && (currencies as readonly unknown[]).includes(value.currency) && (!currency || value.currency === currency);
const dateTime = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const copy = (m: { amount_minor: number; currency: Currency }) => ({ amount_minor: m.amount_minor, currency: m.currency });

/** طلب صرف تجريبي: مبلغ موجب وقناة `sandbox`، ولا بيانات حساب. الحد الأدنى والمتاح يحكم فيهما الخادم. */
export function payoutCreate(body: Record<string, unknown>): PayoutRequestCreate | null {
  if (Object.keys(body).sort().join() !== "amount,channel" || !money(body.amount) || body.amount.amount_minor < 1 || !(payoutChannels as readonly unknown[]).includes(body.channel)) return null;
  return { amount: copy(body.amount), channel: body.channel as PayoutRequestCreate["channel"] };
}
/** الرفض بسبب من القائمة وحده، لا نص حر. */
export function payoutReject(body: Record<string, unknown>): PayoutReject | null {
  return Object.keys(body).join() === "reason_code" && (payoutReasons as readonly unknown[]).includes(body.reason_code) ? { reason_code: body.reason_code as PayoutReject["reason_code"] } : null;
}
/** إصدار سياسة صرف: المبلغان بعملة السياسة، والاحتياطي بنقاط أساس، وتاريخ سريان. */
export function policyInput(body: Record<string, unknown>): PayoutPolicyInput | null {
  if (Object.keys(body).sort().join() !== "currency,dual_approval_above,effective_from,minimum,reserve_bps") return null;
  const currency = body.currency as Currency;
  if (!(currencies as readonly unknown[]).includes(currency) || !money(body.minimum, currency) || !money(body.dual_approval_above, currency) || !dateTime(body.effective_from)) return null;
  // الحد الأدنى أكبر من صفر (قرار المنسّق 2026-11-15): طلب صرف بلا مبلغ لا معنى له، والخادم يرفضه 422
  if ((body.minimum as { amount_minor: number }).amount_minor < 1) return null;
  if (!Number.isSafeInteger(body.reserve_bps) || (body.reserve_bps as number) < 0 || (body.reserve_bps as number) > earningsLimits.reserveMax) return null;
  return { currency, minimum: copy(body.minimum), dual_approval_above: copy(body.dual_approval_above), reserve_bps: body.reserve_bps as number, effective_from: body.effective_from };
}

export function safeSummary(s: EarningsSummary): EarningsSummary {
  return { user_id: s.user_id, as_of: s.as_of, balances: s.balances.map(b => ({ currency: b.currency, pending: copy(b.pending), available: copy(b.available), in_payout: copy(b.in_payout), paid: copy(b.paid), reserve: copy(b.reserve), requestable: copy(b.requestable), minimum: copy(b.minimum) })) };
}
/** سطر الكشف بقائمة بيضاء: ما بيع (المادة وعنوانها ونوع الترخيص والحصة) ويوم البيع وموعد التحرير وحدها، بلا مشترٍ ولا مؤسسة ولا سعر. */
export function safeEntry(e: EarningsEntry): EarningsEntry {
  const sale = e.sale && Array.isArray(e.sale.items) ? { sold_at: e.sale.sold_at, items: e.sale.items.slice(0, 20).map(i => ({ material_id: i.material_id, title: String(i.title).slice(0, 4000), license_type: i.license_type, share: i.share ? { amount_minor: i.share.amount_minor, currency: i.share.currency } : null })) } : null;
  return { id: e.id, entry_id: e.entry_id, kind: e.kind, state: e.state, amount: { amount_minor: e.amount.amount_minor, currency: e.amount.currency }, reference_type: e.reference_type, reference_id: e.reference_id, occurred_at: e.occurred_at, sale, releases_at: typeof e.releases_at === "string" ? e.releases_at : null };
}
/** حركة واحدة في الكشف: سطور القيد الواحد معًا. النقل بين حالتين سطر واحد بوجهته ومصدره؛ وغيره مجموع سطوره بحالة أكبرها. */
export type Movement = EarningsEntry & { from: EarningsEntry["state"] | null };
export function movements(lines: readonly EarningsEntry[]): Movement[] {
  const groups = new Map<string, EarningsEntry[]>();
  for (const l of lines) groups.set(l.entry_id, [...(groups.get(l.entry_id) ?? []), l]);
  return [...groups.values()].map(group => {
    const up = group.filter(l => l.amount.amount_minor > 0), down = group.filter(l => l.amount.amount_minor < 0);
    if (up.length === 1 && down.length === 1 && up[0].amount.amount_minor === -down[0].amount.amount_minor) return { ...up[0], from: down[0].state };
    const total = group.reduce((sum, l) => sum + l.amount.amount_minor, 0), main = [...group].sort((a, b) => Math.abs(b.amount.amount_minor) - Math.abs(a.amount.amount_minor))[0];
    return { ...main, sale: group.find(l => l.sale)?.sale ?? null, releases_at: group.find(l => l.releases_at)?.releases_at ?? null, amount: { amount_minor: total, currency: main.amount.currency }, from: null };
  });
}
/** مبلغ طلب الصرف كما كُتب: رقم موجب بمنزلتين عشريتين على الأكثر؛ ما زاد يُرفض ولا يُقرَّب صامتًا. */
export const twoDecimals = (value: string) => /^\d+(\.\d{1,2})?$/.test(value.trim());
/** الطلب بقائمة بيضاء؛ معرّفات المعتمدين للمالية والإدارة، وصاحب الطلب يرى عددهم وحده (العقد). */
export function safePayout(p: PayoutRequest, staff: boolean): PayoutRequest {
  return {
    id: p.id, user_id: p.user_id, amount: copy(p.amount), channel: p.channel, state: p.state, reason_code: p.reason_code ?? null, approvals_required: p.approvals_required,
    approvals: p.approvals.map(a => staff && a.approver_id ? { approver_id: a.approver_id, approved_at: a.approved_at } : { approved_at: a.approved_at }),
    requested_at: p.requested_at, decided_at: p.decided_at ?? null, completed_at: p.completed_at ?? null,
  };
}
export function safePolicy(p: PayoutPolicy): PayoutPolicy {
  return { id: p.id, currency: p.currency, minimum: copy(p.minimum), dual_approval_above: copy(p.dual_approval_above), reserve_bps: p.reserve_bps, effective_from: p.effective_from, created_by: p.created_by, created_at: p.created_at };
}
/** يمكن لصاحب الطلب إلغاؤه قبل اعتماده وحده، وللمالية اعتماده أو رفضه حسب حالته. */
export const cancellable = (p: PayoutRequest) => p.state === "requested";
export const approvable = (p: PayoutRequest, me: string) => p.state === "requested" && p.user_id !== me && !p.approvals.some(a => a.approver_id === me);
export const rejectable = (p: PayoutRequest) => p.state === "requested" || p.state === "approved";
