import { NextRequest, NextResponse } from "next/server";
import { readConfig, type WebConfig } from "./config";
import { clientAddress, requireOk, upstream, withSession, assertSession } from "./auth";
import { WebError } from "./errors";
import { sessionStore, validSessionId, type SessionStore } from "./sessions";
import { safeDashboard, safeForm, safeMaterial, safeMe, safeNotification, safeTransition } from "@/lib/privacy";
import { materialQuery, materialTypes, uuid } from "@/lib/query";
import type { components } from "@/generated/schema";
import type { MaterialType } from "@/lib/types";
import { streamDerivative } from "./media";
import { actionPath, reviewAction } from "./review-actions";
import { hasRole, materialTag } from "@/lib/review";
import { listUploads, readUpload, uploadAction, uploadBodyLimit, uploadPath } from "./uploads";
import { catalogRead } from "./catalog";
import { safeIdentitySetting, safePermissionHistory } from "@/lib/admin-privacy";
import { pageLimits } from "@/lib/admin-policy";
import { safeRule } from "@/lib/notification-policy";

const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

export function assertSameOrigin(request: Request, config: WebConfig) {
  if (request.headers.get("origin") !== config.origin || request.headers.get("x-requested-with") !== "post-history-web" || request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    throw new WebError(403, "request_failed");
  }
}

function setSession(response: NextResponse, config: WebConfig, value: string) {
  response.cookies.set(config.cookieName, value, { httpOnly: true, secure: config.secure, sameSite: "strict", path: "/", maxAge: value ? config.lifetimeSeconds : 0 });
}

async function bodyOf(request: Request, limit = 8192): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) throw new WebError(413, "request_failed");
  const reader = request.body?.getReader();
  if (!reader) throw new WebError(400, "request_failed");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new WebError(413, "request_failed"); }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new WebError(400, "request_failed"); }
}

export async function handle(request: NextRequest, path: string, deps?: { config: WebConfig; store: SessionStore; fetch?: typeof fetch }): Promise<NextResponse> {
  let config: WebConfig | undefined;
  try {
    config = deps?.config ?? readConfig();
    const store = deps?.store ?? sessionStore(config), transport = deps?.fetch;
    const id = request.cookies.get(config.cookieName)?.value ?? "";
    const isPost = request.method === "POST";
    const isWrite = ["POST", "PUT", "DELETE"].includes(request.method);
    if (isWrite) assertSameOrigin(request, config);
    if (request.method !== "GET" && !isWrite) throw new WebError(405, "request_failed");
    if (isWrite && !(isPost && ["auth/login", "auth/logout"].includes(path)) && !actionPath(path, request.method) && !uploadPath(path, request.method)) throw new WebError(405, "request_failed");

    if (path === "auth/login" && isPost) {
      const input = await bodyOf(request);
      if (typeof input.email !== "string" || input.email.length > 254 || !input.email.includes("@") || typeof input.password !== "string" || input.password.length < 8 || input.password.length > 1024 || (input.totp_code !== undefined && (typeof input.totp_code !== "string" || !/^\d{6}$/.test(input.totp_code)))) throw new WebError(422, "request_failed");
      const body: components["schemas"]["LoginRequest"] = { email: input.email, password: input.password, ...(input.totp_code ? { totp_code: input.totp_code as string } : {}) };
      const result = await upstream(config, undefined, transport, clientAddress(request, config)).POST("/auth/login", { body });
      if (result.response.status === 401) throw new WebError(401, result.error?.code === "totp_required" ? "totp_required" : "login_failed");
      requireOk(result); assertSession(result.data);
      const newId = await store.create(result.data);
      if (validSessionId(id)) await store.locked(id, () => store.remove(id));
      const response = json({ ok: true });
      setSession(response, config, newId); return response;
    }

    if (!validSessionId(id)) throw new WebError(401, "session_revoked");
    const response = await withSession(id, store, config, async api => {
      if (path === "auth/logout" && isPost) {
        const body = await bodyOf(request);
        if (body.all_sessions !== undefined && typeof body.all_sessions !== "boolean") throw new WebError(422, "request_failed");
        requireOk(await api.POST("/auth/logout", { body: { all_sessions: body.all_sessions === true } }));
        await store.remove(id);
        const response = json({ ok: true }); setSession(response, config!, ""); return response;
      }
      const me = requireOk(await api.GET("/auth/me"));
      if (isWrite && uploadPath(path, request.method)) return uploadAction(request, path, api, me, await bodyOf(request, uploadBodyLimit(path)), config!);
      if (isWrite) return reviewAction(request, path, api, me, await bodyOf(request));
      if (path === "auth/me") return json(safeMe(me));
      if (path === "admin/settings/reporter-identity") {
        if (!hasRole(me, "system_admin")) throw new WebError(403, "request_failed");
        if (request.nextUrl.search) throw new WebError(400, "request_failed");
        return json(safeIdentitySetting(requireOk(await api.GET("/admin/settings/reporter-identity"))));
      }
      const permissionHistory = /^users\/([^/]+)\/permissions\/history$/.exec(path);
      if (permissionHistory && uuid.test(permissionHistory[1])) {
        if (!hasRole(me, "system_admin")) throw new WebError(403, "request_failed");
        const search = request.nextUrl.searchParams, limit = search.get("limit") ?? String(pageLimits.default), cursor = search.get("cursor");
        if ([...search.keys()].some(key => !["limit", "cursor"].includes(key) || search.getAll(key).length > 1) || !/^\d+$/.test(limit) || +limit < pageLimits.min || +limit > pageLimits.max || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
        const page = requireOk(await api.GET("/users/{id}/permissions/history", { params: { path: { id: permissionHistory[1] }, query: { limit: +limit, ...(cursor ? { cursor } : {}) } } }));
        return json({ items: page.items.map(safePermissionHistory).filter(item => item !== null), next_cursor: page.next_cursor });
      }
      const media = /^materials\/([^/]+)\/files\/([^/]+)\/content$/.exec(path);
      if (media && uuid.test(media[1]) && uuid.test(media[2]) && !request.nextUrl.search) return streamDerivative(request, api, config!, media[1], media[2], transport);
      if (path === "materials") {
        let query;
        try { query = materialQuery(request.nextUrl.searchParams); } catch { throw new WebError(400, "request_failed"); }
        const page = requireOk(await api.GET("/materials", { params: { query } }));
        return json({ items: page.items.map(m => safeMaterial(m, me.permissions)), next_cursor: page.next_cursor });
      }
      if (path.startsWith("materials/") && uuid.test(path.slice(10))) {
        const result = await api.GET("/materials/{id}", { params: { path: { id: path.slice(10) } } });
        const material = requireOk(result);
        const schema = await api.GET("/forms/{version}", { params: { path: { version: material.form_version } } });
        if (schema.response.status !== 404) requireOk(schema);
        const response = json(safeMaterial(material, me.permissions, schema.data));
        const tag = materialTag(result.response, material); if (tag) response.headers.set("ETag", tag);
        return response;
      }
      const history = /^materials\/([^/]+)\/transitions$/.exec(path);
      if (history && uuid.test(history[1])) {
        const data = requireOk(await api.GET("/materials/{id}/transitions", { params: { path: { id: history[1] } } }));
        return json({ items: data.items.map(safeTransition) });
      }
      if (path === "catalog" || path.startsWith("catalog/")) return catalogRead(request, path, api, me, config!, transport);
      if (path === "uploads") return listUploads(api, me, request.nextUrl.searchParams);
      const upload = /^uploads\/([^/]+)$/.exec(path);
      if (upload && uuid.test(upload[1]) && !request.nextUrl.search) return readUpload(api, upload[1]);
      if (path === "notification-rules" || /^notification-rules\/[^/]+$/.test(path)) {
        if (!hasRole(me, "system_admin", "editor_in_chief") || request.nextUrl.search) throw new WebError(403, "request_failed");
        if (path === "notification-rules") return json({ items: requireOk(await api.GET("/notification-rules")).items.map(safeRule) });
        if (!uuid.test(path.slice(19))) throw new WebError(404, "request_failed");
        const rule = requireOk(await api.GET("/notification-rules/{rule_id}", { params: { path: { rule_id: path.slice(19) } } }));
        const response = json(safeRule(rule)); response.headers.set("ETag", `"${rule.row_version}"`); return response;
      }
      if (path === "dashboard/newsroom") {
        if (!hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin") || request.nextUrl.search) throw new WebError(403, "request_failed");
        return json(safeDashboard(requireOk(await api.GET("/dashboard/newsroom"))));
      }
      if (path === "notifications") {
        const search = request.nextUrl.searchParams;
        if ([...search.keys()].some(key => !["limit", "cursor", "unread_only"].includes(key) || search.getAll(key).length > 1)) throw new WebError(400, "request_failed");
        const limit = search.get("limit") ?? "50", unread = search.get("unread_only"), cursor = search.get("cursor");
        if (!/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (unread !== null && !["true", "false"].includes(unread)) || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
        const page = requireOk(await api.GET("/notifications", { params: { query: { limit: +limit, unread_only: unread === "true", ...(cursor ? { cursor } : {}) } } }));
        return json({ unread_count: page.unread_count, next_cursor: page.next_cursor, items: page.items.map(safeNotification) });
      }
      if (path === "forms/current") {
        const type = request.nextUrl.searchParams.get("material_type");
        if (type && !(materialTypes as readonly string[]).includes(type)) throw new WebError(400, "request_failed");
        return json(safeForm(requireOk(await api.GET("/forms/current", { params: { query: type ? { material_type: type as MaterialType } : {} } })), me.permissions));
      }
      if (/^forms\/[1-9]\d{0,8}$/.test(path)) return json(safeForm(requireOk(await api.GET("/forms/{version}", { params: { path: { version: Number(path.slice(6)) } } })), me.permissions));
      throw new WebError(404, "request_failed");
    }, transport, clientAddress(request, config));
    return response;
  } catch (error) {
    const known = error instanceof WebError ? error : new WebError(503, "temporarily_unavailable");
    const response = json({ code: known.code }, known.status);
    if (known.status === 401 && config && known.code === "session_revoked") setSession(response, config, "");
    return response;
  }
}
