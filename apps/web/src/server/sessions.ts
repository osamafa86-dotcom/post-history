import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { Session } from "@/lib/types";
import type { WebConfig } from "./config";
import { WebError } from "./errors";

export type StoredSession = { tokens: Session; deadline: number };
export interface SessionStore {
  create(tokens: Session): Promise<string>;
  read(id: string): Promise<StoredSession | null>;
  save(id: string, session: StoredSession): Promise<void>;
  remove(id: string): Promise<void>;
  locked<T>(id: string, run: () => Promise<T>): Promise<T>;
}

export function seal(value: StoredSession, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
export function unseal(value: string, key: Buffer): StoredSession {
  const bytes = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8"));
}
export const validSessionId = (id: string) => /^[a-f0-9]{64}$/.test(id);

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis, private readonly config: WebConfig) {}
  private key(id: string) { return `web:session:${id}`; }
  async create(tokens: Session) {
    const id = randomBytes(32).toString("hex");
    await this.save(id, { tokens, deadline: Date.now() + this.config.lifetimeSeconds * 1000 });
    return id;
  }
  async read(id: string) {
    if (!validSessionId(id)) return null;
    const value = await this.redis.get(this.key(id));
    if (!value) return null;
    try {
      const session = unseal(value, this.config.key);
      if (session.deadline <= Date.now()) return null;
      return session;
    } catch { await this.remove(id); return null; }
  }
  async save(id: string, session: StoredSession) {
    const ttl = Math.ceil((session.deadline - Date.now()) / 1000);
    if (ttl <= 0) { await this.remove(id); throw new WebError(401, "session_revoked"); }
    await this.redis.set(this.key(id), seal(session, this.config.key), "EX", ttl);
  }
  async remove(id: string) { await this.redis.del(this.key(id)); }
  async locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const lock = `${this.key(id)}:lock`, owner = randomUUID(), until = Date.now() + 5000;
    while (await this.redis.set(lock, owner, "PX", 45000, "NX") !== "OK") {
      if (Date.now() > until) throw new WebError(503, "temporarily_unavailable");
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    try { return await run(); }
    finally {
      await this.redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, lock, owner);
    }
  }
}

let client: Redis | undefined;
export function sessionStore(config: WebConfig): SessionStore {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
    client.on("error", () => { /* لا نسجّل عناوين الاتصال أو بيانات الجلسة. */ });
  }
  return new RedisSessionStore(client, config);
}
