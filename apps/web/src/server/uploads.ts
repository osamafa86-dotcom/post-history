import { NextResponse } from "next/server";
import type { components } from "@/generated/schema";
import type { Me } from "@/lib/types";
import { hasRole } from "@/lib/review";
import { safeMaterial } from "@/lib/privacy";
import { materialTypes, states, uuid, dateTime } from "@/lib/query";
import { allowedTusEndpoint, sha256Hex, uploadRoles } from "@/lib/upload-policy";
import { requireOk, type Api } from "./auth";
import type { WebConfig } from "./config";
import { WebError } from "./errors";

type MaterialCreate = components["schemas"]["MaterialCreate"];
type UploadSessionCreate = components["schemas"]["UploadSessionCreate"];
type UploadSession = components["schemas"]["UploadSession"];
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Vary": "Cookie" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

// مسارات الكتابة للرفع من الحاسوب (#88)، لأدوار الرفع في العقد.
export const uploadRoutes = [
  { path: "materials", method: "POST" },
  { path: "uploads", method: "POST" },
  { path: "uploads/{id}/web-ingest-token", method: "POST" },
  { path: "uploads/{id}", method: "DELETE" },
] as const;
const patterns = uploadRoutes.map(route => ({ ...route, pattern: new RegExp(`^${route.path.replaceAll(/\{[^}]+\}/g, "[^/]+")}$`) }));
export const uploadPath = (path: string, method: string) => patterns.some(route => route.pattern.test(path) && route.method === method);
// المادة تحمل الحقول الديناميكية؛ أكبر من حد إجراءات المراجعة.
export const uploadBodyLimit = (path: string) => path === "materials" ? 65536 : 8192;

function keys(body: Record<string, unknown>, allowed: string[], required: string[] = allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new WebError(422, "request_failed");
}
const text = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.trim().length >= min && Array.from(value).length <= max;
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function materialInput(body: Record<string, unknown>): MaterialCreate {
  // لا gps ولا مساهمين ولا ملاحظة صوتية من الويب: الموقع الدقيق لا يُجمع هنا (SEC-04)، والحصص لمسؤول الحقوق.
  keys(body, ["title", "material_types", "governorate", "city", "shot_at", "priority", "sensitivity", "display_name", "form_version", "dynamic_fields"], ["title", "material_types", "governorate", "city", "priority", "sensitivity", "display_name", "form_version", "dynamic_fields"]);
  const types = body.material_types, sensitivity = body.sensitivity, display = body.display_name;
  if (!text(body.title, 5, 80) || !text(body.governorate, 1, 64) || !text(body.city, 1, 64)) throw new WebError(422, "request_failed");
  if (!Array.isArray(types) || types.length < 1 || new Set(types).size !== types.length || types.some(type => !(materialTypes as readonly unknown[]).includes(type))) throw new WebError(422, "request_failed");
  if (!(states.priority as readonly unknown[]).includes(body.priority)) throw new WebError(422, "request_failed");
  if (body.shot_at !== undefined && body.shot_at !== null && (typeof body.shot_at !== "string" || !dateTime.test(body.shot_at) || !Number.isFinite(Date.parse(body.shot_at)))) throw new WebError(422, "request_failed");
  if (!plain(sensitivity) || Object.keys(sensitivity).length !== 3 || !["minors", "injured", "graphic"].every(key => typeof sensitivity[key] === "boolean")) throw new WebError(422, "request_failed");
  if (!plain(display) || !["real_name", "pseudonym", "network"].includes(String(display.mode)) || Object.keys(display).some(key => !["mode", "pseudonym"].includes(key))) throw new WebError(422, "request_failed");
  if (display.mode === "pseudonym" ? !text(display.pseudonym, 1, 80) : display.pseudonym !== undefined && display.pseudonym !== null) throw new WebError(422, "request_failed");
  if (!Number.isSafeInteger(body.form_version) || Number(body.form_version) < 1 || !plain(body.dynamic_fields)) throw new WebError(422, "request_failed");
  return {
    title: body.title, material_types: types as MaterialCreate["material_types"], governorate: body.governorate, city: body.city,
    ...(typeof body.shot_at === "string" ? { shot_at: body.shot_at } : {}), priority: body.priority as MaterialCreate["priority"],
    sensitivity: { minors: sensitivity.minors as boolean, injured: sensitivity.injured as boolean, graphic: sensitivity.graphic as boolean },
    display_name: display.mode === "pseudonym" ? { mode: "pseudonym", pseudonym: display.pseudonym as string } : { mode: display.mode as "real_name" | "network" },
    form_version: body.form_version as number, dynamic_fields: body.dynamic_fields,
  };
}

export function uploadInput(body: Record<string, unknown>): UploadSessionCreate {
  // الويب يرفع الأصل وحده: لا نسخة خفيفة تُنتج في المتصفح.
  keys(body, ["material_id", "kind", "size_bytes", "filename", "mime_type", "client_sha256", "client_fingerprint"], ["material_id", "kind", "size_bytes", "filename", "client_sha256"]);
  if (typeof body.material_id !== "string" || !uuid.test(body.material_id) || body.kind !== "original" || !Number.isSafeInteger(body.size_bytes) || Number(body.size_bytes) < 1) throw new WebError(422, "request_failed");
  if (!text(body.filename, 1, 255) || /[\u0000-\u001f/\\]/.test(body.filename) || typeof body.client_sha256 !== "string" || !sha256Hex.test(body.client_sha256)) throw new WebError(422, "request_failed");
  if (body.mime_type !== undefined && body.mime_type !== null && (typeof body.mime_type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(body.mime_type) || body.mime_type.length > 127)) throw new WebError(422, "request_failed");
  const fingerprint = body.client_fingerprint;
  if (fingerprint !== undefined && fingerprint !== null) {
    if (!plain(fingerprint) || Object.keys(fingerprint).some(key => !["size_bytes", "head_sha256", "tail_sha256"].includes(key)) || fingerprint.size_bytes !== body.size_bytes || typeof fingerprint.head_sha256 !== "string" || !sha256Hex.test(fingerprint.head_sha256) || typeof fingerprint.tail_sha256 !== "string" || !sha256Hex.test(fingerprint.tail_sha256)) throw new WebError(422, "request_failed");
  }
  return {
    material_id: body.material_id, kind: "original", size_bytes: body.size_bytes as number, filename: body.filename,
    mime_type: typeof body.mime_type === "string" ? body.mime_type : null, client_sha256: body.client_sha256,
    ...(plain(fingerprint) ? { client_fingerprint: { size_bytes: fingerprint.size_bytes as number, head_sha256: fingerprint.head_sha256 as string, tail_sha256: fingerprint.tail_sha256 as string } } : {}),
  };
}

/** ما يحتاجه المتصفح من الجلسة؛ لا اسم ملف ولا معرّف ملف المصدر المكرر. */
export function safeUploadSession(session: UploadSession) {
  return {
    id: session.id, material_id: session.material_id, kind: session.kind, state: session.state, size_bytes: session.size_bytes,
    bytes_received: session.bytes_received, failure_reason: session.failure_reason ?? null, receipt_number: session.receipt_number ?? null,
    expires_at: session.expires_at, created_at: session.created_at,
  };
}

export async function uploadAction(request: Request, path: string, api: Api, me: Me, body: Record<string, unknown>, config: WebConfig) {
  if (new URL(request.url).search) throw new WebError(400, "request_failed");
  if (!hasRole(me, ...uploadRoles)) throw new WebError(403, "request_failed");
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (!idempotencyKey || !uuid.test(idempotencyKey)) throw new WebError(400, "request_failed");
  const header = { "Idempotency-Key": idempotencyKey };
  if (path === "materials") {
    const data = requireOk(await api.POST("/materials", { params: { header }, body: materialInput(body) }));
    return json(safeMaterial(data, me.permissions), 201);
  }
  if (path === "uploads") {
    const data = requireOk(await api.POST("/uploads", { params: { header }, body: uploadInput(body) }));
    // الرمز يذهب إلى المتصفح لأنه هو من يرفع إلى tus؛ لكن لا إلى أصل خارج قائمة الإعداد.
    if (!allowedTusEndpoint(data.tus_endpoint, config.tusOrigins) || !Number.isSafeInteger(data.part_size_bytes) || data.part_size_bytes < 1048576) throw new WebError(502, "temporarily_unavailable");
    const metadata = Object.fromEntries(Object.entries(data.tus_metadata).filter(([key, value]) => /^[A-Za-z0-9_-]{1,64}$/.test(key) && typeof value === "string"));
    return json({
      ...safeUploadSession(data), tus_endpoint: data.tus_endpoint, tus_metadata: metadata, part_size_bytes: data.part_size_bytes,
      ingest_token_required: data.ingest_token_required === true, upload_token: data.upload_token, upload_token_expires_at: data.upload_token_expires_at,
    }, 201);
  }
  // إلغاء جلسة يملكها المستدعي (abortUploadSession): الخادم يبطل الرموز ويحذف ما وصل.
  const abort = /^uploads\/([^/]+)$/.exec(path);
  if (abort && uuid.test(abort[1]) && request.method === "DELETE") {
    keys(body, []);
    requireOk(await api.DELETE("/uploads/{id}", { params: { path: { id: abort[1] }, header } }));
    return new NextResponse(null, { status: 204, headers: privateHeaders });
  }
  const ingest = /^uploads\/([^/]+)\/web-ingest-token$/.exec(path);
  if (ingest && uuid.test(ingest[1])) {
    keys(body, []);
    const data = requireOk(await api.POST("/uploads/{id}/web-ingest-token", { params: { path: { id: ingest[1] }, header } }));
    return json({ token: data.token, expires_at: data.expires_at });
  }
  throw new WebError(405, "request_failed");
}

const sessionStates = ["created", "in_progress", "completed", "verified", "failed", "deduplicated"] as const;
/** جلسات المستدعي نفسه (listMyUploadSessions)، بالحقول الآمنة وحدها؛ بلا رمز ولا عنوان tus ولا اسم ملف. */
export async function listUploads(api: Api, me: Me, search: URLSearchParams) {
  if (!hasRole(me, ...uploadRoles)) throw new WebError(403, "request_failed");
  if ([...search.keys()].some(key => !["state", "material_id", "limit", "cursor"].includes(key) || (key !== "state" && search.getAll(key).length > 1))) throw new WebError(400, "request_failed");
  const state = search.getAll("state"), material = search.get("material_id"), limit = search.get("limit") ?? "50", cursor = search.get("cursor");
  if (state.some(s => !(sessionStates as readonly string[]).includes(s)) || (material && !uuid.test(material)) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || (cursor?.length ?? 0) > 2048) throw new WebError(400, "request_failed");
  const page = requireOk(await api.GET("/uploads", { params: { query: { ...(state.length ? { state: state as (typeof sessionStates)[number][] } : {}), ...(material ? { material_id: material } : {}), limit: +limit, ...(cursor ? { cursor } : {}) } } }));
  return json({ items: page.items.map(safeUploadSession), next_cursor: page.next_cursor });
}

export async function readUpload(api: Api, id: string) {
  return json(safeUploadSession(requireOk(await api.GET("/uploads/{id}", { params: { path: { id } } }))));
}
