import { NextResponse } from "next/server";
import type { components } from "@/generated/schema";
import type { Me } from "@/lib/types";
import { hasRole, materialTag } from "@/lib/review";
import { safeMaterial } from "@/lib/privacy";
import { editableStates, editInput } from "@/lib/material-edit";
import { uuid } from "@/lib/query";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

type MaterialUpdate = components["schemas"]["MaterialUpdate"];
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
export const materialEditPath = (path: string, method: string) => method === "PATCH" && /^materials\/[^/]+$/.test(path);

/**
 * تعديل الحقول الوصفية (`updateMaterial`) من الويب لصاحب المادة وحده ما دامت قبل القبول (قرار المنسّق 2026-11-15): العنوان والمحافظة
 * والمدينة والأنواع، لا غيرها. بعد القبول يرفع التعديل إصدار المادة ويعيدها إلى المراجعة النهائية، فلا يُفتح من هنا. `If-Match` إلزامي.
 */
export async function materialEdit(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>) {
  const id = path.slice("materials/".length);
  if (!uuid.test(id)) throw new WebError(404, "request_failed");
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  if (!hasRole(me, "reporter")) throw new WebError(403, "request_failed");
  const key = request.headers.get("Idempotency-Key"), tag = request.headers.get("If-Match");
  if (!key || !uuid.test(key)) throw new WebError(400, "request_failed");
  if (!tag || !/^"[0-9]{1,19}"$/.test(tag)) throw new WebError(428, "version_required");
  const input = editInput(body);
  if (!input) throw new WebError(422, "request_failed");
  const current = requireOk(await api.GET("/materials/{id}", { params: { path: { id } } }));
  if (current.reporter_id !== me.user_id) throw new WebError(403, "request_failed");
  if (!(editableStates as readonly string[]).includes(current.editorial_state)) throw new WebError(409, "request_failed");
  const update: MaterialUpdate = input;
  const result = await api.PATCH("/materials/{id}", { params: { path: { id }, header: { "Idempotency-Key": key, "If-Match": tag } }, body: update });
  const material = requireOk(result), response = NextResponse.json(safeMaterial(material, me.permissions), { headers: privateHeaders });
  const next = materialTag(result.response, material); if (next) response.headers.set("ETag", next);
  return response;
}
