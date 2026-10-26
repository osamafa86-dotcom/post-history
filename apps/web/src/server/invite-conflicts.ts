import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { conflictResolve, conflictRoles, conflictStates, safeConflict } from "@/lib/invite-conflict-policy";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

/** طابور تعارض الدعوات (#361): لمدير النظام وحده، والتصفية بالحالة والصفحات. */
export async function conflictRead(request: Request, api: Api, me: Me) {
  if (!hasRole(me, ...conflictRoles)) throw new WebError(403, "request_failed");
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some(key => !["state", "cursor", "limit"].includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed");
  const state = search.get("state"), limit = search.get("limit") ?? "50", cursor = search.get("cursor");
  if ((state && !(conflictStates as readonly string[]).includes(state)) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
  const page = requireOk(await api.GET("/buyer-invite-conflicts", { params: { query: { limit: +limit, ...(state ? { state: state as typeof conflictStates[number] } : {}), ...(cursor ? { cursor } : {}) } } }));
  return json({ items: page.items.map(safeConflict), next_cursor: page.next_cursor });
}

/** الحسم بالحالة ورمز TOTP. رفض الرمز (401 totp_required) لا يُعامل كجلسة منتهية: يعود 422 بكوده كي لا تُحذف جلسة المدير. */
export async function conflictWrite(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }) {
  const match = /^buyer-invite-conflicts\/([^/]+)\/resolve$/.exec(path);
  if (!match || !uuid.test(match[1]) || request.method !== "POST") throw new WebError(405, "request_failed");
  if (!hasRole(me, ...conflictRoles)) throw new WebError(403, "request_failed");
  const input = conflictResolve(body); if (!input) throw new WebError(422, "request_failed");
  const result = await api.POST("/buyer-invite-conflicts/{conflict_id}/resolve", { params: { path: { conflict_id: match[1] }, header }, body: input });
  if (result.response.status === 401 && (result.error as { code?: string } | undefined)?.code === "totp_required") throw new WebError(422, "totp_required");
  return json(safeConflict(requireOk(result)));
}
