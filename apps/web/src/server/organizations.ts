import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { isBuyer, memberInvite, memberManagers, memberUpdate, organizationAdmins, organizationCreate, organizationEditors, organizationInput, organizationReaders, organizationStatuses, safeMember, safeOrganization } from "@/lib/buyer-policy";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200, tag?: string | null) => {
  const response = NextResponse.json(value, { status, headers: privateHeaders });
  if (tag && /^"[0-9]{1,19}"$/.test(tag)) response.headers.set("ETag", tag);
  return response;
};
// عزل المستأجرين في الـBFF أيضًا: المشتري لا يطلب مؤسسة غير مؤسسته، فيرى 404 كالمفقود دون سؤال الخادم.
function ownOrganization(me: Me, id: string) {
  if (!uuid.test(id) || (isBuyer(me) && me.organization_id !== id)) throw new WebError(404, "request_failed");
}

/** قراءة المؤسسات (#203 بند 21/31): القائمة للإدارة والمالية، والمؤسسة لأعضائها، والأعضاء لمديرها. */
export async function organizationRead(request: Request, id: string | undefined, members: boolean, api: Api, me: Me) {
  const search = new URL(request.url).searchParams;
  if (!id) {
    if (!hasRole(me, ...organizationAdmins)) throw new WebError(403, "request_failed");
    if ([...search.keys()].some(key => !["status", "cursor", "limit"].includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed");
    const status = search.get("status"), limit = search.get("limit") ?? "50", cursor = search.get("cursor");
    if ((status && !(organizationStatuses as readonly string[]).includes(status)) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
    const page = requireOk(await api.GET("/buyer-organizations", { params: { query: { limit: +limit, ...(status ? { status: status as typeof organizationStatuses[number] } : {}), ...(cursor ? { cursor } : {}) } } }));
    return json({ items: page.items.map(safeOrganization), next_cursor: page.next_cursor });
  }
  if (search.size) throw new WebError(400, "request_failed");
  ownOrganization(me, id);
  if (members) {
    if (!hasRole(me, ...memberManagers)) throw new WebError(403, "request_failed");
    return json({ items: requireOk(await api.GET("/buyer-organizations/{org_id}/members", { params: { path: { org_id: id } } })).items.map(safeMember) });
  }
  if (!hasRole(me, ...organizationReaders)) throw new WebError(403, "request_failed");
  const result = await api.GET("/buyer-organizations/{org_id}", { params: { path: { org_id: id } } });
  return json(safeOrganization(requireOk(result)), 200, result.response.headers.get("ETag"));
}

/** الكتابة: الإنشاء لمدير النظام، والملف لمديري المؤسسة بـ If-Match، والدعوة والتعديل لمديري الأعضاء. الحالة والمقاعد والمقاعد المستنفدة يحكم فيها الخادم. */
export async function organizationWrite(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>, header: { "Idempotency-Key": string }, versioned: () => { "Idempotency-Key": string; "If-Match": string }) {
  const match = /^buyer-organizations(?:\/([^/]+)(?:\/members(?:\/([^/]+))?)?)?$/.exec(path), members = path.includes("/members");
  if (!match) throw new WebError(405, "request_failed");
  const [, id, user] = match;
  if (!id) {
    if (request.method !== "POST" || !hasRole(me, "system_admin")) throw new WebError(request.method === "POST" ? 403 : 405, "request_failed");
    const input = organizationCreate(body); if (!input) throw new WebError(422, "request_failed");
    // رمز دعوة المدير الأول لا يمر من هنا قبل عقد #289؛ القائمة البيضاء تسقطه.
    const result = await api.POST("/buyer-organizations", { params: { header }, body: input });
    return json(safeOrganization(requireOk(result)), 201, result.response.headers.get("ETag"));
  }
  ownOrganization(me, id);
  if (!members) {
    if (request.method !== "PUT") throw new WebError(405, "request_failed");
    if (!hasRole(me, ...organizationEditors)) throw new WebError(403, "request_failed");
    const input = organizationInput(body); if (!input) throw new WebError(422, "request_failed");
    const result = await api.PUT("/buyer-organizations/{org_id}", { params: { path: { org_id: id }, header: versioned() }, body: input });
    return json(safeOrganization(requireOk(result)), 200, result.response.headers.get("ETag"));
  }
  if (!hasRole(me, ...memberManagers)) throw new WebError(403, "request_failed");
  if (!user && request.method === "POST") {
    const input = memberInvite(body); if (!input) throw new WebError(422, "request_failed");
    return json(safeMember(requireOk(await api.POST("/buyer-organizations/{org_id}/members", { params: { path: { org_id: id }, header }, body: input }))), 201);
  }
  if (user && uuid.test(user) && request.method === "PUT") {
    const input = memberUpdate(body); if (!input) throw new WebError(422, "request_failed");
    return json(safeMember(requireOk(await api.PUT("/buyer-organizations/{org_id}/members/{user_id}", { params: { path: { org_id: id, user_id: user }, header }, body: input }))));
  }
  throw new WebError(405, "request_failed");
}
