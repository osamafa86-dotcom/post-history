export type WebConfig = ReturnType<typeof readConfig>;
export function readConfig() {
  const origin = new URL(process.env.WEB_ORIGIN ?? "http://127.0.0.1:3100");
  const api = new URL(process.env.API_BASE_URL ?? "http://127.0.0.1:3000/v1");
  const local = (u: URL) => ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  const insecure = process.env.WEB_ALLOW_INSECURE_LOCALHOST === "true" && local(origin) && local(api);
  if ((!insecure && (origin.protocol !== "https:" || api.protocol !== "https:")) || origin.username || origin.password || api.username || api.password) {
    throw new Error("Invalid web origin configuration");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || api.search || api.hash) throw new Error("Invalid base URL");
  const mediaOrigins = (process.env.WEB_MEDIA_ORIGINS ?? "").split(",").filter(Boolean).map(value => {
    const url = new URL(value.trim());
    if ((url.protocol !== "https:" && !(insecure && local(url) && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid media origin");
    return url.origin;
  });
  const key = Buffer.from(process.env.WEB_SESSION_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("WEB_SESSION_KEY must contain 32 bytes");
  return {
    origin: origin.origin, api: api.toString().replace(/\/$/, ""), key, mediaOrigins,
    redisUrl: process.env.WEB_REDIS_URL ?? "redis://127.0.0.1:6379/1",
    secure: !insecure, cookieName: insecure ? "ph-session" : "__Host-ph-session",
    lifetimeSeconds: 8 * 60 * 60,
    // الحافة أمام الويب (Caddy) تستبدل X-Forwarded-For بعنوان العميل وحده؛ true فقط حين يكون ذلك صحيحًا في النشر
    trustForwardedFor: process.env.WEB_TRUST_FORWARDED_FOR === "true",
  };
}
