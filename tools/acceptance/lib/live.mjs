// Shared helpers for the live (server-backed) acceptance scripts.
import { createHash, randomUUID } from "node:crypto";
import { freshFetch } from "./http.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(i, 0)];
}

/** Tiny JSON client over fetch with bearer auth and an Idempotency-Key on writes. */
export function client(baseUrl, fetchImpl = freshFetch) {
  const call = async (token, method, path, { body, key, headers = {} } = {}) => {
    const h = { accept: "application/json", ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (method !== "GET") {
      h["content-type"] = "application/json";
      if (key !== null) h["idempotency-key"] = key ?? randomUUID();
    }
    const res = await fetchImpl(baseUrl.replace(/\/$/, "") + path, { method, headers: h, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body: json ?? text, text, headers: Object.fromEntries(res.headers) };
  };
  return { call, get: (t, p) => call(t, "GET", p) };
}

export function materialBody(formVersion, title, extra = {}) {
  return {
    title, material_types: ["report"], governorate: "gaza", city: "c", priority: "normal",
    sensitivity: { minors: false, injured: false, graphic: false }, display_name: { mode: "network" },
    form_version: formVersion, dynamic_fields: {}, ...extra,
  };
}

/** JSON with sorted keys: two bodies are "the same response" when their JSON values are equal, whatever the key order (jsonb storage reorders keys). */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** All events of a type from GET /events, following next_after until exhausted. */
export async function eventsOfType(http, token, type) {
  const out = [];
  let after = "";
  for (let i = 0; i < 200; i++) {
    const r = await http.get(token, `/events?type=${encodeURIComponent(type)}&limit=100${after ? `&after=${after}` : ""}`);
    if (r.status !== 200) throw new Error(`GET /events answered ${r.status}`);
    out.push(...(r.body.items ?? []));
    if (!r.body.next_after || !(r.body.items ?? []).length) break;
    after = r.body.next_after;
  }
  return out;
}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * جلسة رفع حقيقية من POST /uploads كما يفعل تطبيق المراسل. البصمة إلزامية افتراضيًا؛ `omitClientSha256`
 * محجوز لحالة الرفض الصريحة، و`expectedStatus` يسمح بفحصها دون فتح الباب لطلب ناقص في سكربت آخر.
 */
export async function createUploadSession(http, token, {
  materialId, bytes = null, size = bytes?.length,
  clientSha256 = bytes ? sha256Hex(bytes) : null,
  kind = "original", filename = "clip.mp4", key = randomUUID(),
  expectedStatus = 201, omitClientSha256 = false,
}) {
  if (!Number.isInteger(size) || (!omitClientSha256 && !/^[0-9a-f]{64}$/.test(clientSha256 ?? ""))) {
    throw new Error("createUploadSession needs the file: bytes, or size and a 64-hex clientSha256");
  }
  if (omitClientSha256 && expectedStatus === 201) throw new Error("omitting client_sha256 requires a negative expectedStatus");
  const declared = { material_id: materialId, kind, size_bytes: size, filename };
  if (!omitClientSha256) declared.client_sha256 = clientSha256;
  const r = await http.call(token, "POST", "/uploads", { body: declared, key });
  if (expectedStatus === 201 && r.status !== 201) throw new Error(`POST /uploads answered ${r.status}: ${String(r.text).slice(0, 200)}`);
  return { id: r.body?.id, token: r.body?.upload_token, size, status: r.status, body: r.body, text: r.text };
}
