import { NextRequest, NextResponse } from "next/server";
import { readConfig, type WebConfig } from "./config";
import { clientAddress, requireOk, upstream, withSession, assertSession } from "./auth";
import { WebError } from "./errors";
import { sessionStore, validSessionId, type SessionStore } from "./sessions";
import { safeForm, safeMaterial, safeMe } from "@/lib/privacy";
import { materialQuery, materialTypes, uuid } from "@/lib/query";
import type { components } from "@/generated/schema";
import type { MaterialType } from "@/lib/types";
import { streamDerivative } from "./media";

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

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > 8192) throw new WebError(413, "request_failed");
  const reader = request.body?.getReader();
  if (!reader) throw new WebError(400, "request_failed");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw new WebError(413, "request_failed"); }
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
    if (isPost) assertSameOrigin(request, config);
    if (request.method !== "GET" && !isPost) throw new WebError(405, "request_failed");

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
      if (isPost) throw new WebError(405, "request_failed");
      const me = requireOk(await api.GET("/auth/me"));
      if (path === "auth/me") return json(safeMe(me));
      const media = /^materials\/([^/]+)\/files\/([^/]+)\/content$/.exec(path);
      if (media && uuid.test(media[1]) && uuid.test(media[2]) && !request.nextUrl.search) return streamDerivative(request, api, config!, media[1], media[2], transport);
      if (path === "materials") {
        let query;
        try { query = materialQuery(request.nextUrl.searchParams); } catch { throw new WebError(400, "request_failed"); }
        const page = requireOk(await api.GET("/materials", { params: { query } }));
        return json({ items: page.items.map(m => safeMaterial(m, me.permissions)), next_cursor: page.next_cursor });
      }
      if (path.startsWith("materials/") && uuid.test(path.slice(10))) {
        const material = requireOk(await api.GET("/materials/{id}", { params: { path: { id: path.slice(10) } } }));
        const schema = await api.GET("/forms/{version}", { params: { path: { version: material.form_version } } });
        if (schema.response.status !== 404) requireOk(schema);
        return json(safeMaterial(material, me.permissions, schema.data));
      }
      if (path === "notifications") {
        const page = requireOk(await api.GET("/notifications", { params: { query: { limit: 1 } } }));
        return json({ unread_count: page.unread_count, next_cursor: null, items: page.items.map(n => ({ id: n.id, type: n.type, material_id: n.material_id, title: "", priority: n.priority, state: n.state, escalation_level: n.escalation_level, created_at: n.created_at })) });
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
