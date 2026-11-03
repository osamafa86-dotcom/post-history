import { NextResponse } from "next/server";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { uuid } from "@/lib/query";
import { internalNames } from "@/lib/work-name";
import { assignRoles, assignmentDetails, assignmentInput, candidatesMax, exportRoles, myTaskRoles, myTaskStatuses, safeAssignment, safeCandidate, safeExport, safeMyPage, taskPageLimit, taskReaders, transitionInput, transitionRoles } from "@/lib/assignment-policy";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";
import { checkLink } from "./media";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });
type Header = { "Idempotency-Key": string };

/** مسارات الإسناد والتصدير في الـBFF (ADR 0096، ADR 0097). */
const reads = /^(?:materials\/([^/]+)\/(assignments|export|export\/download-url)|assignments\/([^/]+)|me\/assignments|assignment-candidates)$/;
export const assignmentPath = (path: string) => reads.test(path) || /^assignments\/[^/]+\/transitions$/.test(path);

function role(me: Me, ...roles: Parameters<typeof hasRole>[1][]) { if (!hasRole(me, ...roles)) throw new WebError(403, "request_failed"); }
function id(value: string | undefined) { if (!value || !uuid.test(value)) throw new WebError(404, "request_failed"); return value; }
function noQuery(request: Request) { if (new URL(request.url).search) throw new WebError(400, "request_failed"); }
function single(search: URLSearchParams, allowed: string[]) { if ([...search.keys()].some(key => !allowed.includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed"); }

/** رموز الإسناد والتصدير تمرّ برمزها وتفاصيلها الآلية المنقّاة؛ وما عداها كما في `requireOk`. */
function taskOk<T>(result: { data?: T; error?: unknown; response: Response }): T {
  const status = result.response.status, error = result.error && typeof result.error === "object" ? result.error as { code?: unknown; details?: unknown } : {};
  const code = typeof error.code === "string" ? error.code : "";
  if ((status === 409 && ["assignment_not_allowed", "assignment_open", "invalid_transition", "export_not_ready"].includes(code)) || (status === 422 && code === "assignee_not_eligible")) {
    throw new WebError(status, code, assignmentDetails(code, error.details));
  }
  return requireOk(result);
}
function task(item: Parameters<typeof safeAssignment>[0], me: Me) {
  const safe = safeAssignment(item, internalNames(me));
  if (!safe) throw new WebError(502, "temporarily_unavailable");
  return safe;
}

export async function assignmentRead(request: Request, path: string, api: Api, me: Me, config: WebConfig) {
  const match = reads.exec(path);
  if (!match) throw new WebError(404, "request_failed");
  const search = new URL(request.url).searchParams;
  if (match[1]) {
    const material = id(match[1]);
    if (match[2] === "assignments") {
      role(me, ...taskReaders); single(search, ["limit"]);
      const limit = search.get("limit") ?? "20";
      if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 50) throw new WebError(400, "request_failed");
      const page = requireOk(await api.GET("/materials/{id}/assignments", { params: { path: { id: material }, query: { limit: +limit } } }));
      return json({ items: page.items.map(item => safeAssignment(item, internalNames(me))).filter(item => item !== null) });
    }
    role(me, ...exportRoles); noQuery(request);
    if (match[2] === "export") {
      const state = safeExport(requireOk(await api.GET("/materials/{id}/export", { params: { path: { id: material } } })));
      if (!state) throw new WebError(502, "temporarily_unavailable");
      return json(state);
    }
    // رابط الحزمة يُطلب عند النقر ولا يُخزَّن، ومن أصول التخزين في الإعداد وبعمر ≤ 10 دقائق؛ والخادم يسجّل كل إصدار في التدقيق.
    const link = checkLink(taskOk(await api.GET("/materials/{id}/export/download-url", { params: { path: { id: material } } })), config);
    return json({ url: link.url, expires_at: link.expires_at });
  }
  if (match[3]) {
    role(me, ...taskReaders); noQuery(request);
    return json(task(requireOk(await api.GET("/assignments/{assignment_id}", { params: { path: { assignment_id: id(match[3]) } } })), me));
  }
  if (path === "me/assignments") {
    role(me, ...myTaskRoles); single(search, ["status", "cursor", "limit"]);
    const status = search.get("status") ?? "active", limit = search.get("limit") ?? String(taskPageLimit), cursor = search.get("cursor");
    if (!(myTaskStatuses as readonly string[]).includes(status) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 50 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
    const page = requireOk(await api.GET("/me/assignments", { params: { query: { status: status as "active" | "closed", limit: +limit, ...(cursor ? { cursor } : {}) } } }));
    return json(safeMyPage(page, internalNames(me)));
  }
  role(me, ...assignRoles); noQuery(request);
  const items = requireOk(await api.GET("/assignment-candidates")).items.slice(0, candidatesMax);
  return json({ items: items.map(safeCandidate).filter(item => item !== null) });
}

export async function assignmentWrite(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>, header: Header) {
  noQuery(request);
  const assign = /^materials\/([^/]+)\/assignments$/.exec(path);
  if (assign) {
    role(me, ...assignRoles);
    const input = assignmentInput(body);
    if (!input) throw new WebError(422, "request_failed");
    return json(task(taskOk(await api.POST("/materials/{id}/assignments", { params: { path: { id: id(assign[1]) }, header }, body: input })), me), 201);
  }
  const move = /^assignments\/([^/]+)\/transitions$/.exec(path);
  if (move) {
    role(me, ...transitionRoles);
    const input = transitionInput(body);
    if (!input) throw new WebError(422, "request_failed");
    return json(task(taskOk(await api.POST("/assignments/{assignment_id}/transitions", { params: { path: { assignment_id: id(move[1]) }, header }, body: input })), me));
  }
  const exporting = /^materials\/([^/]+)\/export$/.exec(path);
  if (exporting) {
    role(me, ...exportRoles);
    if (Object.keys(body).length) throw new WebError(422, "request_failed");
    const result = await api.POST("/materials/{id}/export", { params: { path: { id: id(exporting[1]) }, header } });
    const state = safeExport(requireOk(result));
    if (!state) throw new WebError(502, "temporarily_unavailable");
    return json(state, result.response.status === 202 ? 202 : 200);
  }
  throw new WebError(405, "request_failed");
}
