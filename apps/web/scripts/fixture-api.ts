// خادم بيانات اصطناعية للاختبار والقياس المحلي فقط؛ لا يدخل حزمة التطبيق.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { form, material, me, tokens } from "../tests/fixtures";
import assets from "../tests/media-fixture.json";
import type { Me, Material, Notification, TransitionRecord, PermissionHistoryEntry, ReporterIdentitySetting, ReporterIdentitySettingUpdate, Permission } from "../src/lib/types";
const materials: Material[] = [], notifications: Notification[] = [], history = new Map<string, TransitionRecord[]>();
const writes: { path: string; method: string; key: string; body: Record<string, unknown> }[] = [];
const applied = new Map<string, { fingerprint: string; value: unknown; status: number }>();
let dropNextWrite = false;
let identitySetting: ReporterIdentitySetting, historyUnavailable = false, auditSequence = 21;
const permissionAudit: { target: string | null; entry: PermissionHistoryEntry }[] = [];
function reset() {
  materials.splice(0, materials.length, ...Array.from({ length: 200 }, (_, i) => ({ ...material(i + 1), row_version: 17, reserved_by: null, reserved_at: null, contributors: [{ user_id: me.user_id, role: "reporter" as const, share_percent: 100 }] })));
  materials[1].editorial_state = "accepted"; materials[2].technical_state = "failed";
  notifications.splice(0, notifications.length, ...Array.from({ length: 3 }, (_, i) => ({ id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, type: "never-display-canary", title: "never-display-canary", material_id: materials[i].id, priority: "normal" as const, state: "sent" as const, created_at: "2026-10-20T12:00:00Z" })));
  history.clear(); writes.length = 0; applied.clear(); dropNextWrite = false;
  identitySetting = { access: "separate", updated_at: "2026-10-21T10:00:00Z", updated_by: null }; historyUnavailable = false; auditSequence = 21;
  permissionAudit.splice(0, permissionAudit.length, ...Array.from({ length: 21 }, (_, i) => ({ target: "10000000-0000-4000-8000-000000000002", entry: { id: String(21 - i), kind: i % 2 ? "permission_revoked" as const : "permission_granted" as const, permission: "reporter_identity:read" as const, actor_id: me.user_id, occurred_at: new Date(Date.parse(identitySetting.updated_at) - i * 1000).toISOString(), reason_code: null } })));
}
// الرفع من الحاسوب (#88): جلسات رفع وخادم tus اصطناعي بفحص رمز ingest كالبوابة، وCORS لأصل الويب وحده.
type FixtureUpload = { session: Record<string, unknown> & { id: string; material_id: string; state: string; size_bytes: number; bytes_received: number; receipt_number: string | null; failure_reason: string | null }; sha: string; token: string; tus?: string };
const uploads = new Map<string, FixtureUpload>(), tusFiles = new Map<string, { sid: string; length: number; offset: number; hash: ReturnType<typeof createHash>; patches: number; resent: number; cuts: number }>();
const ingestTokens = new Map<string, { sid: string; expires: number }>();
const tusFaults = { rejectIngest: 0, failPatches: 0, cutNext: false, revoked: false };
const webOrigin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3100", fixtureOrigin = `http://127.0.0.1:${process.env.WEB_FIXTURE_PORT ?? 3201}`;
function resetUploads() { uploads.clear(); tusFiles.clear(); ingestTokens.clear(); Object.assign(tusFaults, { rejectIngest: 0, failPatches: 0, cutNext: false, revoked: false }); }
function finishUpload(upload: FixtureUpload, digest: string) {
  const item = materials.find(m => m.id === upload.session.material_id);
  if (digest !== upload.sha) { Object.assign(upload.session, { state: "failed", failure_reason: "checksum_mismatch" }); if (item) item.technical_state = "failed"; return; }
  const receipt = `R-261021-${String(uploads.size).padStart(6, "0")}`;
  Object.assign(upload.session, { state: "verified", receipt_number: receipt, bytes_received: upload.session.size_bytes });
  if (item) { item.technical_state = "verified"; item.files = [{ id: randomUUID(), kind: "original", state: "verified", mime_type: "video/quicktime", receipt_number: receipt, created_at: new Date().toISOString() }]; }
}
async function tus(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) {
  res.setHeader("Access-Control-Allow-Origin", webOrigin); res.setHeader("Vary", "Origin"); res.setHeader("Tus-Resumable", "1.0.0");
  res.setHeader("Access-Control-Expose-Headers", "Location, Upload-Offset, Upload-Length, Tus-Resumable");
  const end = (status: number, headers: Record<string, string | number> = {}) => { res.statusCode = status; for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(); };
  if (req.method === "OPTIONS") return end(204, { "Access-Control-Allow-Methods": "POST, HEAD, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Ingest-Token, Tus-Resumable, Upload-Length, Upload-Metadata, Upload-Offset, Content-Type", "Access-Control-Max-Age": 600 });
  const id = url.pathname.slice("/files/".length), file = tusFiles.get(id);
  const metadata = Object.fromEntries(String(req.headers["upload-metadata"] ?? "").split(",").filter(Boolean).map(pair => { const [k, v = ""] = pair.trim().split(" "); return [k, Buffer.from(v, "base64").toString()]; }));
  const sid = file?.sid ?? metadata.upload_session_id, grant = ingestTokens.get(String(req.headers["ingest-token"] ?? ""));
  // البوابة: رمز ingest صالح لهذه الجلسة وحدها، وإلا 401 (يطلب العميل رمزًا جديدًا).
  if (tusFaults.rejectIngest > 0 && req.method === "PATCH") { tusFaults.rejectIngest--; return end(401); }
  if (!grant || grant.sid !== sid || grant.expires < Date.now()) return end(401);
  // فحص حالة الجلسة عند البوابة (SEC-01): جلسة دخول مبطلة 403 حتى مع رمز صالح.
  if (tusFaults.revoked) return end(403);
  const upload = uploads.get(sid);
  if (!upload || ["failed", "verified"].includes(upload.session.state)) return end(403);
  if (req.method === "POST" && !id) {
    if (req.headers.authorization !== `Bearer ${upload.token}` || upload.tus) return end(403);
    const created = randomUUID(); upload.tus = created; upload.session.state = "in_progress";
    tusFiles.set(created, { sid, length: Number(req.headers["upload-length"]), offset: 0, hash: createHash("sha256"), patches: 0, resent: 0, cuts: 0 });
    return end(201, { Location: `${fixtureOrigin}/files/${created}` });
  }
  if (!file) return end(404);
  if (req.method === "HEAD") return end(200, { "Upload-Offset": file.offset, "Upload-Length": file.length, "Cache-Control": "no-store" });
  if (req.method === "DELETE") { tusFiles.delete(id); Object.assign(upload.session, { state: "failed", failure_reason: "aborted" }); return end(204); }
  if (req.method !== "PATCH") return end(405);
  const offset = Number(req.headers["upload-offset"]);
  if (offset !== file.offset) { file.resent++; return end(409); }
  if (tusFaults.failPatches > 0 && file.offset > 0) { tusFaults.failPatches--; req.resume(); return end(503); }
  file.patches++;
  let received = 0; const cut = tusFaults.cutNext; tusFaults.cutNext = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    file.hash.update(chunk); file.offset += chunk.length; received += chunk.length;
    upload.session.bytes_received = file.offset;
    // قطع متعمد للاتصال بعد بعض الجزء: ما وصل يُحفظ والإزاحة تتقدم بقدره، كما في tusd.
    if (cut && received >= 65536) { file.cuts++; req.socket.destroy(); return; }
  }
  if (file.offset === file.length) { upload.session.state = "completed"; finishUpload(upload, file.hash.copy().digest("hex")); }
  return end(204, { "Upload-Offset": file.offset });
}
// قواعد التنبيه (#203 بند 7): مراجعة صف لكل قاعدة كما في العقد.
const rules = new Map<string, Record<string, unknown> & { id: string; row_version: number }>();
reset();
const signed = new Map<string, { kind: "proxy" | "thumbnail"; expires: number }>();
let expireNextProxy = false;
const access = new Map<string, Me>(), refresh = new Map<string, Me>();
function profile(email: string): Me {
  const names: Record<string, Me["roles"]> = { chief: [{ name: "editor_in_chief", scopes: [] }], reviewer: ["supervisor", "rights_officer", "producer"].map(name => ({ name: name as Me["roles"][number]["name"], scopes: [] })), admin: [{ name: "system_admin", scopes: [] }], reporter: [{ name: "reporter", scopes: [] }] };
  return { ...me, roles: names[email.split("@")[0]] ?? [], permissions: email.startsWith("permissions@") ? ["sensitive_location:read", "protected_source:read", "reporter_identity:read"] : [] };
}
function session(user: Me) {
  const value = { ...tokens(), access_token: randomUUID(), refresh_token: randomUUID(), roles: user.roles };
  access.set(value.access_token, user); refresh.set(value.refresh_token, user); return value;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(status === 204 ? "" : JSON.stringify(value)); };
  if (url.pathname === "/health") return send({ ok: true });
  if (url.pathname.startsWith("/files/")) { res.removeHeader("Content-Type"); return tus(req, res, url); }
  if (url.pathname === "/__test/tus" && req.method === "POST") { const query = url.searchParams; Object.assign(tusFaults, { rejectIngest: Number(query.get("reject_ingest") ?? 0), failPatches: Number(query.get("fail_patches") ?? 0), cutNext: query.get("cut") === "1", revoked: tusFaults.revoked }); return send({ ok: true }); }
  if (url.pathname === "/__test/uploads") return send([...uploads.values()].map(u => ({ state: u.session.state, receipt: u.session.receipt_number, ingest_tokens: [...ingestTokens.values()].filter(t => t.sid === u.session.id).length, ...(u.tus ? (({ length, offset, patches, resent, cuts }) => ({ length, offset, patches, resent, cuts }))(tusFiles.get(u.tus) ?? { length: 0, offset: 0, patches: 0, resent: 0, cuts: 0 }) : {}) })));
  if (url.pathname === "/__test/reset" && req.method === "POST") { rules.clear(); reset(); resetUploads(); return send({ ok: true }); }
  if (url.pathname === "/__test/state") return send({ writes, applied: applied.size, identitySetting, auditCount: permissionAudit.length });
  if (url.pathname === "/__test/history-unavailable" && req.method === "POST") { historyUnavailable = true; return send({ ok: true }); }
  if (url.pathname === "/__test/bump-rule" && req.method === "POST") { for (const rule of rules.values()) rule.row_version++; return send({ ok: true }); }
  if (url.pathname === "/__test/bump" && req.method === "POST") { materials[0].row_version!++; return send({ ok: true }); }
  if (url.pathname === "/__test/drop-write" && req.method === "POST") { dropNextWrite = true; return send({ ok: true }); }
  if (url.pathname === "/__test/revoke-role" && req.method === "POST") { for (const user of access.values()) user.roles = []; return send({ ok: true }); }
  if (url.pathname === "/__test/revoke" && req.method === "POST") { access.clear(); refresh.clear(); tusFaults.revoked = true; return send({ ok: true }); }
  if (url.pathname === "/__test/expire-media" && req.method === "POST") { expireNextProxy = true; return send({ ok: true }); }
  if (url.pathname === "/derived/fixture") {
    const grant = signed.get(url.searchParams.get("signature") ?? "");
    if (!grant || grant.expires <= Date.now() || req.headers.authorization || req.headers.cookie) return send({}, 403);
    const bytes = Buffer.from(grant.kind === "proxy" ? assets.mp4 : assets.png, "base64");
    res.setHeader("Content-Type", grant.kind === "proxy" ? "video/mp4" : "image/png"); res.setHeader("Accept-Ranges", "bytes");
    let start = 0, end = bytes.length - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) return send({}, 416);
      start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end) return send({}, 416);
      res.statusCode = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    }
    res.setHeader("Content-Length", end - start + 1); return res.end(bytes.subarray(start, end + 1));
  }
  let body: Record<string, unknown> = {};
  if (["POST", "PUT", "DELETE"].includes(req.method ?? "")) {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 65536) return send({}, 413); }
    try { body = JSON.parse(raw || "{}"); } catch { return send({}, 400); }
    if (!req.headers["idempotency-key"]) return send({ code: "missing_idempotency_key" }, 400);
  }
  if (url.pathname === "/v1/auth/login" && req.method === "POST") {
    if (body.password !== "synthetic-password") return send({ code: "unauthorized" }, 401);
    if (body.totp_code !== "123456") return send({ code: "totp_required" }, 401);
    return send(session(profile(String(body.email))));
  }
  if (url.pathname === "/v1/auth/refresh" && req.method === "POST") {
    const user = refresh.get(String(body.refresh_token));
    if (!user || !refresh.delete(String(body.refresh_token))) return send({ code: "unauthorized" }, 401);
    return send(session(user));
  }
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (!access.has(token)) return send({ code: "unauthorized" }, 401);
  if (url.pathname === "/v1/auth/logout" && req.method === "POST") { if (body.all_sessions) { access.clear(); refresh.clear(); } else access.delete(token); return send(null, 204); }
  const user = access.get(token)!;
  if (url.pathname === "/v1/auth/me") return send(user);
  const isWrite = ["POST", "PUT", "DELETE"].includes(req.method ?? "");
  if (isWrite) {
    const path = decodeURIComponent(url.pathname), key = String(req.headers["idempotency-key"]), fingerprint = JSON.stringify([path, req.method, body]);
    writes.push({ path, method: req.method!, key, body });
    const cached = applied.get(key);
    if (cached) return cached.fingerprint === fingerprint ? send(cached.value, cached.status) : send({}, 409);
    const has = (...roles: string[]) => user.roles.some(role => roles.includes(role.name));
    const commit = (value: unknown, status = 204) => { applied.set(key, { fingerprint, value: structuredClone(value), status }); if (dropNextWrite) { dropNextWrite = false; return send({ message: "never-display-canary" }, 503); } return send(value, status); };
    const match = /^\/v1\/materials\/([^/]+)\/(transitions|reservation|contributors)$/.exec(path);
    if (match) {
      const item = materials.find(m => m.id === match[1]); if (!item) return send({}, 404);
      if (req.method !== "DELETE" && req.headers["if-match"] !== `"${item.row_version}"`) return send({}, 412);
      const stamp = new Date().toISOString();
      if (match[2] === "transitions") {
        const track = body.track as "technical" | "editorial" | "rights", column = `${track}_state` as const;
        if (track === "editorial" && !has("supervisor", "producer") || track === "rights" && !has("rights_officer") || track === "technical" && !has("reporter")) return send({}, 403);
        const from = item[column]; Object.assign(item, { [column]: body.to }); item.row_version!++;
        history.set(item.id, [...(history.get(item.id) ?? []), { id: randomUUID(), track, from, to: String(body.to), reason: String(body.reason), actor_id: user.user_id, occurred_at: stamp }]);
        return commit(item, 200);
      }
      if (match[2] === "contributors" && req.method === "PUT") { if (!has("rights_officer", "system_admin")) return send({}, 403); item.contributors = body.contributors as Material["contributors"]; item.row_version!++; return commit(item, 200); }
      if (match[2] === "reservation") {
        if (req.method === "DELETE") { if (!has("producer", "supervisor", "editor_in_chief", "system_admin")) return send({}, 403); item.reserved_by = null; item.reserved_at = null; item.row_version!++; return commit(null); }
        if (!has("producer", "editor_in_chief")) return send({}, 403);
        if (!["accepted", "in_production"].includes(item.editorial_state) || item.reserved_by && item.reserved_by !== user.user_id) return send({}, 409);
        item.reserved_by = user.user_id; item.reserved_at = stamp; item.editorial_state = "in_production"; item.row_version!++;
        return commit({ material_id: item.id, reserved_by: user.user_id, reserved_at: stamp, releases_at: new Date(Date.now() + 1800000).toISOString() }, 200);
      }
    }
    if (path === "/v1/admin/settings/reporter-identity" && req.method === "PUT") {
      if (!has("system_admin")) return send({}, 403);
      const input = body as ReporterIdentitySettingUpdate;
      if (input.access !== identitySetting.access) {
        identitySetting = { access: input.access, updated_by: user.user_id, updated_at: new Date().toISOString() };
        permissionAudit.unshift({ target: null, entry: { id: String(++auditSequence), kind: "setting_changed", setting: "reporter_legal_name_access", value: input.access, actor_id: user.user_id, occurred_at: identitySetting.updated_at, reason_code: input.reason_code } });
      }
      return commit(identitySetting, 200);
    }
    const permissionPath = /^\/v1\/users\/([^/]+)\/permissions\/([^/]+)$/.exec(path);
    if (permissionPath) {
      if (!has("system_admin")) return send({}, 403);
      permissionAudit.unshift({ target: permissionPath[1], entry: { id: String(++auditSequence), kind: req.method === "PUT" ? "permission_granted" : "permission_revoked", permission: permissionPath[2] as Permission, actor_id: user.user_id, occurred_at: new Date().toISOString(), reason_code: null } });
      return commit(null);
    }
    if (path === "/v1/materials" && req.method === "POST") {
      if (!has("reporter", "supervisor", "producer", "editor_in_chief")) return send({}, 403);
      const stamp = new Date().toISOString(), base = material(materials.length + 1);
      const created: Material = { ...base, id: randomUUID(), ...(body as Partial<Material>), reporter_id: user.user_id, technical_state: "pending", editorial_state: "inbox", rights_state: "unknown", files: [], row_version: 1, reserved_by: null, reserved_at: null, created_at: stamp, updated_at: stamp };
      materials.unshift(created); return commit(created, 201);
    }
    if (path === "/v1/uploads" && req.method === "POST") {
      if (!has("reporter", "supervisor", "producer", "editor_in_chief")) return send({}, 403);
      if (!materials.some(m => m.id === body.material_id)) return send({}, 404);
      const id = randomUUID(), now = Date.now();
      const session = { id, material_id: String(body.material_id), kind: "original", state: "created", size_bytes: Number(body.size_bytes), tus_endpoint: process.env.FIXTURE_TUS_ENDPOINT ?? `${fixtureOrigin}/files/`,
        tus_metadata: { upload_session_id: id, filename: String(body.filename) }, part_size_bytes: Number(process.env.FIXTURE_PART_SIZE ?? 1048576), bytes_received: 0, ingest_token_required: !process.env.FIXTURE_TUS_ENDPOINT,
        ietf_resumable: false, checksum_algorithm: "sha256", expires_at: new Date(now + 86400000).toISOString(), file_id: null, duplicate_of_file_id: null, failure_reason: null, receipt_number: null, created_at: new Date(now).toISOString() };
      const token = randomUUID(); uploads.set(id, { session, sha: String(body.client_sha256), token });
      return commit({ ...session, upload_token: token, upload_token_expires_at: new Date(now + 3600000).toISOString() }, 201);
    }
    const abortPath = /^\/v1\/uploads\/([^/]+)$/.exec(path);
    if (abortPath && req.method === "DELETE") {
      const upload = uploads.get(abortPath[1]); if (!upload) return send({}, 404);
      if (["verified", "deduplicated"].includes(upload.session.state)) return send({ code: "upload_state_conflict" }, 409);
      Object.assign(upload.session, { state: "failed", failure_reason: "aborted" }); return commit(null);
    }
    const ingestPath = /^\/v1\/uploads\/([^/]+)\/web-ingest-token$/.exec(path);
    if (ingestPath) {
      const upload = uploads.get(ingestPath[1]);
      if (!upload) return send({}, 404);
      if (upload.session.state !== "created" && upload.session.state !== "in_progress") return send({}, 409);
      const token = randomUUID(), expires = Date.now() + 600000; ingestTokens.set(token, { sid: upload.session.id, expires });
      return commit({ token, expires_at: new Date(expires).toISOString() }, 200);
    }
    if (path === "/v1/notification-rules" && req.method === "POST") {
      if (!has("system_admin")) return send({}, 403);
      const stamp = new Date().toISOString(), rule = { ...body, id: randomUUID(), row_version: 1, created_by: user.user_id, updated_by: user.user_id, created_at: stamp, updated_at: stamp };
      rules.set(rule.id, rule); res.setHeader("ETag", '"1"'); return commit(rule, 201);
    }
    const rulePath = /^\/v1\/notification-rules\/([^/]+)$/.exec(path);
    if (rulePath) {
      if (!has("system_admin")) return send({}, 403);
      const rule = rules.get(rulePath[1]); if (!rule) return send({}, 404);
      if (req.headers["if-match"] !== `"${rule.row_version}"`) return send({}, 412);
      if (req.method === "DELETE") { rules.delete(rule.id); return commit(null); }
      const next = { ...rule, ...body, row_version: rule.row_version + 1, updated_at: new Date().toISOString() }; rules.set(rule.id, next);
      res.setHeader("ETag", `"${next.row_version}"`); return commit(next, 200);
    }
    if (/^\/v1\/users\/[^/]+\/status$/.test(path)) { if (!has("system_admin")) return send({}, 403); return commit(null); }
    const notice = /^\/v1\/notifications\/([^/]+)\/(read|ack)$/.exec(path);
    if (notice) { const item = notifications.find(n => n.id === notice[1]); if (!item) return send({}, 404); item.read_at = new Date().toISOString(); item.state = notice[2] === "ack" ? "acknowledged" : "read"; if (notice[2] === "ack") item.acknowledged_at = item.read_at; return commit(null); }
    return send({}, 405);
  }
  if (url.pathname === "/v1/admin/settings/reporter-identity") {
    if (!user.roles.some(role => role.name === "system_admin")) return send({}, 403);
    return send({ ...identitySetting, reporter_legal_name: "never-display-canary" });
  }
  const permissionTrail = /^\/v1\/users\/([^/]+)\/permissions\/history$/.exec(url.pathname);
  if (permissionTrail) {
    if (!user.roles.some(role => role.name === "system_admin")) return send({}, 403);
    if (historyUnavailable) return send({ message: "never-display-canary" }, 404);
    const items = permissionAudit.filter(row => row.target === null || row.target === permissionTrail[1]);
    const start = Number(url.searchParams.get("cursor") ?? 0), limit = Number(url.searchParams.get("limit") ?? 50);
    return send({ items: items.slice(start, start + limit).map(row => ({ ...row.entry, reason: "never-display-canary", legal_name: "never-display-canary" })), next_cursor: start + limit < items.length ? String(start + limit) : null });
  }
  if (url.pathname === "/v1/uploads") {
    const states = url.searchParams.getAll("state"), wanted = states.length ? states : ["created", "in_progress", "completed"];
    return send({ items: [...uploads.values()].map(u => u.session).filter(s => wanted.includes(s.state)).map(s => ({ ...s, upload_token: "never-display-canary" })).reverse(), next_cursor: null });
  }
  const uploadRead = /^\/v1\/uploads\/([^/]+)$/.exec(url.pathname);
  if (uploadRead) { const upload = uploads.get(uploadRead[1]); return upload ? send(upload.session) : send({}, 404); }
  if (url.pathname === "/v1/notification-rules" || url.pathname.startsWith("/v1/notification-rules/")) {
    if (!user.roles.some(role => ["system_admin", "editor_in_chief"].includes(role.name))) return send({}, 403);
    if (url.pathname === "/v1/notification-rules") return send({ items: [...rules.values()].map(rule => ({ ...rule, secret_note: "never-display-canary" })) });
    const rule = rules.get(url.pathname.slice("/v1/notification-rules/".length)); if (!rule) return send({}, 404);
    res.setHeader("ETag", `"${rule.row_version}"`); return send(rule);
  }
  if (url.pathname === "/v1/dashboard/newsroom") {
    if (!user.roles.some(role => ["supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin"].includes(role.name))) return send({}, 403);
    const count = (key: "editorial_state" | "technical_state" | "rights_state") => Object.entries(materials.reduce<Record<string, number>>((all, m) => ({ ...all, [m[key]]: (all[m[key]] ?? 0) + 1 }), {})).map(([state, count]) => ({ state, count }));
    return send({ generated_at: new Date().toISOString(), editorial: [...count("editorial_state"), { state: "never-display-canary", count: 1 }], technical: count("technical_state"), rights: count("rights_state"),
      urgent_open: materials.filter(m => m.priority === "urgent" && !["published", "rejected"].includes(m.editorial_state)).length,
      reserved: materials.filter(m => m.reserved_by).map(m => ({ material_id: m.id, reserved_by: m.reserved_by, reserved_at: m.reserved_at, priority: m.priority, editorial_state: m.editorial_state, title: "never-display-canary" })),
      recent_receipts: materials.slice(0, 3).map(m => ({ material_id: m.id, receipt_number: `R-261021-${m.id.slice(-6)}`, verified_at: m.created_at, priority: m.priority })),
      overdue_acknowledgements: 2 });
  }
  if (url.pathname === "/v1/notifications") { const items = url.searchParams.get("unread_only") === "true" ? notifications.filter(n => !n.read_at) : notifications; return send({ items, next_cursor: null, unread_count: notifications.filter(n => !n.read_at).length }); }
  const trail = /^\/v1\/materials\/([^/]+)\/transitions$/.exec(url.pathname);
  if (trail) return send({ items: history.get(trail[1]) ?? [] });
  if (url.pathname === "/v1/forms/current" || url.pathname === `/v1/forms/${form.version}`) return send(form);
  const derivative = /^\/v1\/materials\/([^/]+)\/files\/([^/]+)\/download-url$/.exec(url.pathname);
  if (derivative) {
    const file = materials.find(m => m.id === derivative[1])?.files.find(f => f.id === derivative[2] && f.state === "verified");
    if (!file || (file.kind !== "proxy" && file.kind !== "thumbnail")) return send({ code: "not_found" }, 404);
    const signature = randomUUID(), expires = Date.now() + 300000;
    signed.set(signature, { kind: file.kind, expires: file.kind === "proxy" && expireNextProxy ? 0 : expires });
    if (file.kind === "proxy") expireNextProxy = false;
    return send({ url: `http://127.0.0.1:${process.env.WEB_FIXTURE_PORT ?? 3201}/derived/fixture?signature=${signature}`, expires_at: new Date(expires).toISOString() });
  }
  if (url.pathname === "/v1/materials") {
    let filtered = materials;
    for (const key of ["governorate", "reporter_id", "technical_state", "editorial_state", "rights_state", "priority"] as const) {
      const value = url.searchParams.get(key); if (value) filtered = filtered.filter(m => m[key] === value);
    }
    const after = url.searchParams.get("shot_after"), before = url.searchParams.get("shot_before");
    if (after) filtered = filtered.filter(m => Date.parse(m.shot_at!) >= Date.parse(after));
    if (before) filtered = filtered.filter(m => Date.parse(m.shot_at!) < Date.parse(before));
    const start = Number(url.searchParams.get("cursor") ?? 0), limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);
    return send({ items: filtered.slice(start, start + limit).map(m => ({ ...m, gps: { lat: 12.345678, lng: 23.456789 }, protected_source: "never-display-canary", device_id: "never-display-canary" })), next_cursor: start + limit < filtered.length ? String(start + limit) : null });
  }
  const found = materials.find(m => `/v1/materials/${m.id}` === url.pathname);
  if (found) { res.setHeader("ETag", `"${found.row_version}"`); return send(found); }
  return send({ code: "not_found" }, 404);
});
server.listen(Number(process.env.WEB_FIXTURE_PORT ?? 3201), "127.0.0.1", () => console.log("Synthetic API ready"));
process.once("SIGTERM", () => server.close());
