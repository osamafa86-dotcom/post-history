import { NextResponse } from "next/server";
import { formReaders, formWriters, publishBody, safeFormSummary, validForm } from "@/lib/form-admin";
import { hasRole } from "@/lib/review";
import { safeForm } from "@/lib/privacy";
import { uuid } from "@/lib/query";
import type { Me } from "@/lib/types";
import { requireOk, upstream } from "./auth";
import { WebError } from "./errors";

const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie" } });
export async function manageForms(request: Request, api: ReturnType<typeof upstream>, me: Me, body?: unknown) {
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  if (request.method === "GET") {
    if (!hasRole(me, ...formReaders)) throw new WebError(403, "request_failed");
    return json({ items: requireOk(await api.GET("/forms")).items.map(safeFormSummary) });
  }
  if (!hasRole(me, ...formWriters)) throw new WebError(403, "request_failed");
  const key = request.headers.get("Idempotency-Key"), tag = request.headers.get("If-Match");
  if (!key || !uuid.test(key)) throw new WebError(400, "request_failed");
  if (!tag) throw new WebError(428, "request_failed");
  if (!/^"(?:0|[1-9]\d{0,8})"$/.test(tag)) throw new WebError(400, "request_failed");
  if (!validForm(body) || body.version !== Number(tag.slice(1, -1)) + 1) throw new WebError(422, "request_failed");
  const result = requireOk(await api.POST("/forms", { params: { header: { "Idempotency-Key": key, "If-Match": tag } }, body: publishBody(body) }));
  if (!validForm(result)) throw new WebError(502, "request_failed");
  return json(safeForm(result, me.permissions), 201);
}
