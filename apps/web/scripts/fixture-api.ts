// خادم بيانات اصطناعية للاختبار والقياس المحلي فقط؛ لا يدخل حزمة التطبيق.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { form, material, me, tokens } from "../tests/fixtures";
import assets from "../tests/media-fixture.json";
const materials = Array.from({ length: 200 }, (_, i) => material(i + 1));
const signed = new Map<string, { kind: "proxy" | "thumbnail"; expires: number }>();
let expireNextProxy = false;
const access = new Set<string>(), refresh = new Set<string>();
function session() {
  const value = { ...tokens(), access_token: randomUUID(), refresh_token: randomUUID() };
  access.add(value.access_token); refresh.add(value.refresh_token); return value;
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
  const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(status === 204 ? "" : JSON.stringify(value)); };
  if (url.pathname === "/health") return send({ ok: true });
  if (url.pathname === "/__test/revoke" && req.method === "POST") { access.clear(); refresh.clear(); return send({ ok: true }); }
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
  if (req.method === "POST") {
    let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return send({}, 413); }
    try { body = JSON.parse(raw || "{}"); } catch { return send({}, 400); }
    if (!req.headers["idempotency-key"]) return send({ code: "missing_idempotency_key" }, 400);
  }
  if (url.pathname === "/v1/auth/login" && req.method === "POST") {
    if (body.password !== "synthetic-password") return send({ code: "unauthorized" }, 401);
    if (body.totp_code !== "123456") return send({ code: "totp_required" }, 401);
    return send(session());
  }
  if (url.pathname === "/v1/auth/refresh" && req.method === "POST") {
    if (!refresh.delete(String(body.refresh_token))) return send({ code: "unauthorized" }, 401);
    return send(session());
  }
  const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (!access.has(token)) return send({ code: "unauthorized" }, 401);
  if (url.pathname === "/v1/auth/logout" && req.method === "POST") { if (body.all_sessions) { access.clear(); refresh.clear(); } else access.delete(token); return send(null, 204); }
  if (url.pathname === "/v1/auth/me") return send(me);
  if (url.pathname === "/v1/notifications") return send({ items: [], next_cursor: null, unread_count: 3 });
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
  if (found) return send(found);
  return send({ code: "not_found" }, 404);
});
server.listen(Number(process.env.WEB_FIXTURE_PORT ?? 3201), "127.0.0.1", () => console.log("Synthetic API ready"));
process.once("SIGTERM", () => server.close());
