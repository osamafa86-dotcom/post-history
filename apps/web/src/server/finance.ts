import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { commissionInput, commissionReaders, commissionScopes, commissionWriters, safeCommissionRule } from "@/lib/commission-policy";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

/** قواعد العمولة (#203، ADR 0025 الجزء 6): القراءة للمالية ومدير النظام، والتصفية بالنطاق وحده. */
export async function commissionRead(request: Request, api: Api, me: Me) {
  if (!hasRole(me, ...commissionReaders)) throw new WebError(403, "request_failed");
  const search = new URL(request.url).searchParams, scope = search.get("scope");
  if ([...search.keys()].some(key => key !== "scope" || search.getAll(key).length > 1) || (scope !== null && !(commissionScopes as readonly string[]).includes(scope))) throw new WebError(400, "request_failed");
  const page = requireOk(await api.GET("/commission-rules", { params: { query: scope ? { scope: scope as typeof commissionScopes[number] } : {} } }));
  return json({ items: page.items.map(safeCommissionRule) });
}

/** لا تعديل ولا حذف: كل تغيير صف جديد بتاريخ سريان، لمدير النظام وحده. */
export async function commissionWrite(request: Request, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }) {
  if (request.method !== "POST") throw new WebError(405, "request_failed");
  if (!hasRole(me, ...commissionWriters)) throw new WebError(403, "request_failed");
  const input = commissionInput(body); if (!input) throw new WebError(422, "request_failed");
  return json(safeCommissionRule(requireOk(await api.POST("/commission-rules", { params: { header }, body: input }))), 201);
}
