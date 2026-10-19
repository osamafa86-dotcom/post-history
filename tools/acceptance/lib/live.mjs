// Shared helpers for the live (server-backed) acceptance scripts.
import { randomUUID } from "node:crypto";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(i, 0)];
}

/** Tiny JSON client over fetch with bearer auth and an Idempotency-Key on writes. */
export function client(baseUrl, fetchImpl = fetch) {
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
    return { status: res.status, body: json ?? text, text };
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
