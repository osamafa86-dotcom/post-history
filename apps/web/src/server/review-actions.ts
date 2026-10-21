import { NextResponse } from "next/server";
import type { components } from "@/generated/schema";
import type { Me, Permission, Transition } from "@/lib/types";
import { hasRole, validContributors } from "@/lib/review";
import { states, uuid } from "@/lib/query";
import { safeMaterial } from "@/lib/privacy";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const permissions: Permission[] = ["sensitive_location:read", "protected_source:read"];
export const actionPath = (path: string) => /^materials\/[^/]+\/(transitions|contributors|reservation)$/.test(path) || /^users\/[^/]+\/(status|permissions\/[^/]+)$/.test(path) || /^notifications\/[^/]+\/(read|ack)$/.test(path);
function requireRole(me: Me, ...roles: components["schemas"]["RoleName"][]) { if (!hasRole(me, ...roles)) throw new WebError(403, "request_failed"); }
function keys(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) throw new WebError(422, "request_failed"); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max; }
const done = () => new NextResponse(null, { status: 204, headers: privateHeaders });

export async function reviewAction(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>) {
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || !uuid.test(idempotencyKey)) throw new WebError(400, "request_failed");
  const header = { "Idempotency-Key": idempotencyKey };
  const versioned = () => {
    const tag = request.headers.get("If-Match");
    if (!tag || !/^"[0-9]{1,19}"$/.test(tag)) throw new WebError(428, "version_required");
    return { ...header, "If-Match": tag };
  };
  const materialPath = /^materials\/([^/]+)\/(transitions|contributors|reservation)$/.exec(path);
  if (materialPath && uuid.test(materialPath[1])) {
    const id = materialPath[1], kind = materialPath[2];
    if (kind === "transitions" && request.method === "POST") {
      requireRole(me, "reporter", "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin");
      keys(body, ["track", "to", "reason", "note_timecode_ms"]);
      if (!["technical", "editorial", "rights"].includes(String(body.track)) || !text(body.reason, 2000) || typeof body.to !== "string" || (body.note_timecode_ms !== undefined && body.note_timecode_ms !== null && (!Number.isSafeInteger(body.note_timecode_ms) || Number(body.note_timecode_ms) < 0))) throw new WebError(422, "request_failed");
      const track = body.track as Transition["track"], targets = states[`${track}_state`];
      if (!(targets as readonly string[]).includes(body.to)) throw new WebError(422, "request_failed");
      if (track === "technical" && (body.to !== "pending" || !hasRole(me, "reporter"))) throw new WebError(403, "request_failed");
      if (track === "rights" && body.to === "sellable") throw new WebError(403, "request_failed");
      const payload: Transition = { track, to: body.to, reason: body.reason, ...(body.note_timecode_ms !== undefined ? { note_timecode_ms: body.note_timecode_ms as number | null } : {}) };
      const data = requireOk(await api.POST("/materials/{id}/transitions", { params: { path: { id }, header: versioned() }, body: payload }));
      return NextResponse.json(safeMaterial(data, me.permissions), { headers: privateHeaders });
    }
    if (kind === "contributors" && request.method === "PUT") {
      requireRole(me, "rights_officer", "system_admin"); keys(body, ["contributors"]);
      if (!validContributors(body.contributors)) throw new WebError(422, "request_failed");
      const contributors = body.contributors.map(({ user_id, role, share_percent }) => ({ user_id, role, share_percent }));
      const data = requireOk(await api.PUT("/materials/{id}/contributors", { params: { path: { id }, header: versioned() }, body: { contributors } }));
      return NextResponse.json(safeMaterial(data, me.permissions), { headers: privateHeaders });
    }
    if (kind === "reservation" && request.method === "POST") {
      requireRole(me, "producer", "editor_in_chief"); keys(body, []);
      const data = requireOk(await api.POST("/materials/{id}/reservation", { params: { path: { id }, header: versioned() } }));
      return NextResponse.json({ material_id: data.material_id, reserved_by: data.reserved_by, reserved_at: data.reserved_at, releases_at: data.releases_at }, { headers: privateHeaders });
    }
    if (kind === "reservation" && request.method === "DELETE") {
      requireRole(me, "producer", "supervisor", "editor_in_chief", "system_admin"); keys(body, []);
      requireOk(await api.DELETE("/materials/{id}/reservation", { params: { path: { id }, header } })); return done();
    }
  }
  const permissionPath = /^users\/([^/]+)\/permissions\/([^/]+)$/.exec(path);
  if (permissionPath && uuid.test(permissionPath[1]) && permissions.includes(permissionPath[2] as Permission)) {
    requireRole(me, "system_admin"); const params = { path: { id: permissionPath[1], permission: permissionPath[2] as Permission }, header };
    if (request.method === "PUT") {
      keys(body, ["reason"]); if (!text(body.reason, 500)) throw new WebError(422, "request_failed");
      requireOk(await api.PUT("/users/{id}/permissions/{permission}", { params, body: { reason: body.reason } })); return done();
    }
    if (request.method === "DELETE") { keys(body, []); requireOk(await api.DELETE("/users/{id}/permissions/{permission}", { params })); return done(); }
  }
  const userPath = /^users\/([^/]+)\/status$/.exec(path);
  if (userPath && uuid.test(userPath[1]) && request.method === "PUT") {
    requireRole(me, "system_admin"); keys(body, ["status"]);
    if (body.status !== "active" && body.status !== "suspended") throw new WebError(422, "request_failed");
    if (body.status === "suspended" && userPath[1] === me.user_id) throw new WebError(403, "request_failed");
    requireOk(await api.PUT("/users/{id}/status", { params: { path: { id: userPath[1] }, header }, body: { status: body.status } })); return done();
  }
  const notificationPath = /^notifications\/([^/]+)\/(read|ack)$/.exec(path);
  if (notificationPath && uuid.test(notificationPath[1]) && request.method === "POST") {
    keys(body, []); const params = { path: { id: notificationPath[1] }, header };
    if (notificationPath[2] === "read") requireOk(await api.POST("/notifications/{id}/read", { params }));
    else requireOk(await api.POST("/notifications/{id}/ack", { params }));
    return done();
  }
  throw new WebError(405, "request_failed");
}
