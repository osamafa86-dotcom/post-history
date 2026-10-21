import Redis from "ioredis";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RedisSessionStore } from "../src/server/sessions";
import { withSession, requireOk } from "../src/server/auth";
import { tokens, me } from "./fixtures";

describe.skipIf(!process.env.WEB_TEST_REDIS_URL)("real Redis coordination", () => {
  it("persists encrypted tokens and rotates exactly once across two store instances", async () => {
    const url = process.env.WEB_TEST_REDIS_URL!, redis = new Redis(url);
    const config = { origin: "https://web.example.test", api: "https://api.example.test/v1", key: randomBytes(32), redisUrl: url, secure: true, cookieName: "__Host-ph-session", lifetimeSeconds: 3600, mediaOrigins: [], trustForwardedFor: false };
    const one = new RedisSessionStore(redis, config), two = new RedisSessionStore(redis, config);
    let id = "", refreshes = 0;
    try {
      id = await one.create({ ...tokens(), expires_at: new Date(0).toISOString() });
      expect(await redis.get(`web:session:${id}`)).not.toContain("synthetic-refresh");
      const transport = (async (input: RequestInfo | URL) => {
        const req = input as Request;
        if (req.url.endsWith("/auth/refresh")) { refreshes++; await new Promise(resolve => setTimeout(resolve, 80)); return Response.json(tokens()); }
        return Response.json(me);
      }) as typeof fetch;
      await Promise.all([one, two, one, two].map(store => withSession(id, store, config, async api => requireOk(await api.GET("/auth/me")), transport)));
      expect(refreshes).toBe(1); expect((await two.read(id))?.tokens.refresh_token).toBe("synthetic-refresh");
      await one.locked(id, () => one.remove(id)); expect(await two.read(id)).toBeNull();
    } finally { if (id) await one.remove(id); await redis.quit(); }
  });
});
