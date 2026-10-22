import { NextResponse } from "next/server";
import type { components } from "@/generated/schema";
import type { Me, Permission, Transition, ReporterIdentitySettingUpdate } from "@/lib/types";
import { hasRole, validContributors } from "@/lib/review";
import { states, uuid } from "@/lib/query";
import { safeMaterial } from "@/lib/privacy";
import { requireOk, type Api } from "./auth";
import { WebError } from "./errors";
import { identityAccesses, identityReasons, permissions, reasonLimits } from "@/lib/admin-policy";
import { safeIdentitySetting } from "@/lib/admin-privacy";
import { ruleInput, safeRule } from "@/lib/notification-policy";
import { safeTemplate, templateInput, templateWriters } from "@/lib/license-policy";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
export const actionRoutes = [
  { path: "/materials/{id}/transitions", methods: ["post"] },
  { path: "/materials/{id}/contributors", methods: ["put"] },
  { path: "/materials/{id}/reservation", methods: ["post", "delete"] },
  { path: "/users/{id}/status", methods: ["put"] },
  { path: "/users/{id}/permissions/{permission}", methods: ["put", "delete"] },
  { path: "/notifications/{id}/read", methods: ["post"] },
  { path: "/notifications/{id}/ack", methods: ["post"] },
  { path: "/admin/settings/reporter-identity", methods: ["put"] },
  { path: "/notification-rules", methods: ["post"] },
  { path: "/notification-rules/{rule_id}", methods: ["put", "delete"] },
  { path: "/license-templates", methods: ["post"] },
  { path: "/license-templates/{template_id}", methods: ["put"] },
] as const;
const routePatterns = actionRoutes.map(route => ({ ...route, pattern: new RegExp(`^${route.path.slice(1).replaceAll(/\{[^}]+\}/g, "[^/]+")}$`) }));
export const actionPath = (path: string, method: string) => routePatterns.some(route => route.pattern.test(path) && (route.methods as readonly string[]).includes(method.toLowerCase()));
function requireRole(me: Me, ...roles: components["schemas"]["RoleName"][]) { if (!hasRole(me, ...roles)) throw new WebError(403, "request_failed"); }
function keys(body: Record<string, unknown>, allowed: string[]) { if (Object.keys(body).some(key => !allowed.includes(key))) throw new WebError(422, "request_failed"); }
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max; }
const done = () => new NextResponse(null, { status: 204, headers: privateHeaders });

function ruleResponse(result: { data?: components["schemas"]["NotificationRule"]; response: Response }, status: number) {
  const rule = requireOk(result), response = NextResponse.json(safeRule(rule), { status, headers: privateHeaders });
  response.headers.set("ETag", `"${rule.row_version}"`); return response;
}
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
      if (!["technical", "editorial", "rights"].includes(String(body.track)) || !text(body.reason, reasonLimits.transition) || typeof body.to !== "string" || (body.note_timecode_ms !== undefined && body.note_timecode_ms !== null && (!Number.isSafeInteger(body.note_timecode_ms) || Number(body.note_timecode_ms) < 0))) throw new WebError(422, "request_failed");
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
      keys(body, ["reason"]); if (!text(body.reason, reasonLimits.permission)) throw new WebError(422, "request_failed");
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
  if (path === "admin/settings/reporter-identity" && request.method === "PUT") {
    requireRole(me, "system_admin"); keys(body, ["access", "reason_code"]);
    if (!identityAccesses.includes(body.access as ReporterIdentitySettingUpdate["access"]) || !identityReasons.includes(body.reason_code as ReporterIdentitySettingUpdate["reason_code"])) throw new WebError(422, "request_failed");
    const payload: ReporterIdentitySettingUpdate = { access: body.access as ReporterIdentitySettingUpdate["access"], reason_code: body.reason_code as ReporterIdentitySettingUpdate["reason_code"] };
    const data = requireOk(await api.PUT("/admin/settings/reporter-identity", { params: { header }, body: payload }));
    return NextResponse.json(safeIdentitySetting(data), { headers: privateHeaders });
  }
  // قواعد التنبيه (#203 بند 7): الكتابة لمدير النظام وحده كما في العقد، والاستبدال والحذف بـ If-Match.
  if (path === "notification-rules" && request.method === "POST") {
    requireRole(me, "system_admin"); const input = ruleInput(body); if (!input) throw new WebError(422, "request_failed");
    const result = await api.POST("/notification-rules", { params: { header }, body: input });
    return ruleResponse(result, 201);
  }
  const rulePath = /^notification-rules\/([^/]+)$/.exec(path);
  if (rulePath && uuid.test(rulePath[1])) {
    requireRole(me, "system_admin"); const params = { path: { rule_id: rulePath[1] }, header: versioned() };
    if (request.method === "PUT") { const input = ruleInput(body); if (!input) throw new WebError(422, "request_failed"); return ruleResponse(await api.PUT("/notification-rules/{rule_id}", { params, body: input }), 200); }
    if (request.method === "DELETE") { keys(body, []); requireOk(await api.DELETE("/notification-rules/{rule_id}", { params })); return done(); }
  }
  // قوالب التراخيص (v0.3): الكتابة لمدير النظام ومسؤول الحقوق، والاستبدال إصدار جديد بـ If-Match من رقم الإصدار.
  const templatePath = /^license-templates(?:\/([^/]+))?$/.exec(path);
  if (templatePath && (templatePath[1] === undefined ? request.method === "POST" : uuid.test(templatePath[1]) && request.method === "PUT")) {
    requireRole(me, ...templateWriters); const input = templateInput(body); if (!input) throw new WebError(422, "request_failed");
    const result = templatePath[1] ? await api.PUT("/license-templates/{template_id}", { params: { path: { template_id: templatePath[1] }, header: versioned() }, body: input }) : await api.POST("/license-templates", { params: { header }, body: input });
    const template = requireOk(result), response = NextResponse.json(safeTemplate(template), { status: templatePath[1] ? 200 : 201, headers: privateHeaders });
    response.headers.set("ETag", `"${template.version}"`); return response;
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
