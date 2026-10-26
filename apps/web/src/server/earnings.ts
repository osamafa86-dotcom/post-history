import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { currencies } from "@/lib/license-policy";
import { earnerRoles, payableStates, payoutCreate, payoutReject, payoutStaff, payoutStates, policyInput, policyWriters, safeEntry, safePayout, safePolicy, safeSummary } from "@/lib/earnings-policy";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });
const routes = /^(?:me\/earnings(\/entries)?|users\/([^/]+)\/earnings|me\/payout-requests|payout-requests(?:\/([^/]+)(?:\/(approve|reject|cancel))?)?|payout-policies)$/;
export const earningsPath = (path: string) => routes.test(path);
function role(me: Me, ...roles: Parameters<typeof hasRole>[1][]) { if (!hasRole(me, ...roles)) throw new WebError(403, "request_failed"); }

function query(request: Request, allowed: string[]) {
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some(key => !allowed.includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed");
  const limit = search.get("limit") ?? "50", cursor = search.get("cursor");
  if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
  return { search, page: { limit: +limit, ...(cursor ? { cursor } : {}) } };
}
const oneOf = <T extends string>(value: string | null, list: readonly T[]) => { if (value !== null && !(list as readonly string[]).includes(value)) throw new WebError(400, "request_failed"); return value as T | null; };

/** القراءة (ADR 0033): المراسل يرى أرباحه وطلباته، والمالية ومدير النظام الطلبات وأرصدة المساهمين والسياسات. */
export async function earningsRead(request: Request, path: string, api: Api, me: Me) {
  const staff = hasRole(me, ...payoutStaff), match = routes.exec(path)!;
  if (path === "me/earnings") { role(me, ...earnerRoles); query(request, []); return json(safeSummary(requireOk(await api.GET("/me/earnings")))); }
  if (path === "me/earnings/entries") {
    role(me, ...earnerRoles); const { search, page } = query(request, ["currency", "state", "cursor", "limit"]);
    const currency = oneOf(search.get("currency"), currencies), state = oneOf(search.get("state"), payableStates);
    const data = requireOk(await api.GET("/me/earnings/entries", { params: { query: { ...page, ...(currency ? { currency } : {}), ...(state ? { state } : {}) } } }));
    return json({ items: data.items.map(safeEntry), next_cursor: data.next_cursor });
  }
  if (match[2] !== undefined) {
    if (!uuid.test(match[2])) throw new WebError(404, "request_failed");
    role(me, ...payoutStaff); query(request, []);
    return json(safeSummary(requireOk(await api.GET("/users/{id}/earnings", { params: { path: { id: match[2] } } }))));
  }
  if (path === "me/payout-requests") {
    role(me, ...earnerRoles); const { page } = query(request, ["cursor", "limit"]);
    const data = requireOk(await api.GET("/me/payout-requests", { params: { query: page } }));
    return json({ items: data.items.map(p => safePayout(p, false)), next_cursor: data.next_cursor });
  }
  if (path === "payout-requests") {
    role(me, ...payoutStaff); const { search, page } = query(request, ["state", "user_id", "cursor", "limit"]);
    const state = oneOf(search.get("state"), payoutStates), user = search.get("user_id");
    if (user !== null && !uuid.test(user)) throw new WebError(400, "request_failed");
    const data = requireOk(await api.GET("/payout-requests", { params: { query: { ...page, ...(state ? { state } : {}), ...(user ? { user_id: user } : {}) } } }));
    return json({ items: data.items.map(p => safePayout(p, true)), next_cursor: data.next_cursor });
  }
  if (match[3] !== undefined && match[4] === undefined) {
    if (!uuid.test(match[3])) throw new WebError(404, "request_failed");
    role(me, ...payoutStaff, ...earnerRoles); query(request, []);
    return json(safePayout(requireOk(await api.GET("/payout-requests/{payout_request_id}", { params: { path: { payout_request_id: match[3] } } })), staff));
  }
  if (path === "payout-policies") { role(me, ...payoutStaff); query(request, []); return json({ items: requireOk(await api.GET("/payout-policies")).items.map(safePolicy) }); }
  throw new WebError(405, "request_failed");
}

/** الكتابة: المراسل يطلب صرفًا تجريبيًا ويلغيه قبل اعتماده؛ المالية تعتمد وترفض بسبب مرمّز؛ مدير النظام يضيف إصدار سياسة. */
export async function earningsWrite(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }) {
  const match = routes.exec(path);
  if (!match || request.method !== "POST") throw new WebError(405, "request_failed");
  if (path === "me/payout-requests") {
    role(me, ...earnerRoles); const input = payoutCreate(body); if (!input) throw new WebError(422, "request_failed");
    return json(safePayout(requireOk(await api.POST("/me/payout-requests", { params: { header }, body: input })), false), 201);
  }
  if (path === "payout-policies") {
    role(me, ...policyWriters); const input = policyInput(body); if (!input) throw new WebError(422, "request_failed");
    return json(safePolicy(requireOk(await api.POST("/payout-policies", { params: { header }, body: input }))), 201);
  }
  const [, , , id, action] = match;
  if (!id || !action || !uuid.test(id)) throw new WebError(405, "request_failed");
  const params = { path: { payout_request_id: id }, header };
  if (action === "cancel") {
    role(me, ...earnerRoles); if (Object.keys(body).length) throw new WebError(422, "request_failed");
    return json(safePayout(requireOk(await api.POST("/payout-requests/{payout_request_id}/cancel", { params })), false));
  }
  role(me, ...payoutStaff);
  if (action === "approve") {
    if (Object.keys(body).length) throw new WebError(422, "request_failed");
    return json(safePayout(requireOk(await api.POST("/payout-requests/{payout_request_id}/approve", { params })), true));
  }
  const input = payoutReject(body); if (!input) throw new WebError(422, "request_failed");
  return json(safePayout(requireOk(await api.POST("/payout-requests/{payout_request_id}/reject", { params, body: input })), true));
}
