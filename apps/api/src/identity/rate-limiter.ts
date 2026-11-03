import type Redis from 'ioredis';
import { createHmac, hkdfSync } from 'node:crypto';

// زيادة ذرية تضبط عمر النافذة عند أول محاولة فقط (نافذة ثابتة).
const RECORD = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c`;

/**
 * حد معدل بنافذة ثابتة في Redis، مشترك بين كل نسخ الخادم. يعدّ ما يسجّله المستدعي فقط (المحاولات الفاشلة).
 * المفاتيح HMAC-SHA256 بمفتاح مشتق من سر الخادم: لا بريد ولا عنوان IP خامًا في Redis، ولا يمكن عكسها بتجربة
 * كل العناوين كما مع تجزئة عارية (فضاء IPv4 صغير).
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly max: number,
    private readonly windowMs: number,
    private readonly keyMaterial: Buffer,
  ) {}

  private key(raw: string): string {
    return `rl:${this.name}:${createHmac('sha256', this.keyMaterial).update(raw).digest('hex')}`;
  }

  /** ثواني الانتظار إن بلغ المفتاح الحد، وإلا 0. لا يسجّل شيئًا. */
  async retryAfter(raw: string): Promise<number> {
    const key = this.key(raw);
    const [count, ttl] = await Promise.all([this.redis.get(key), this.redis.pttl(key)]);
    if (Number(count ?? 0) < this.max || ttl <= 0) return 0;
    return Math.max(1, Math.ceil(ttl / 1000));
  }

  async record(raw: string): Promise<void> {
    await this.redis.eval(RECORD, 1, this.key(raw), this.windowMs);
  }

  async reset(raw: string): Promise<void> {
    await this.redis.del(this.key(raw));
  }
}

/** سياسة التأخير المتضاعف لعدّاد فشل (ADR 0113). */
export interface BackoffPolicy {
  /** فشل بلا تأخير قبل أن يبدأ التضاعف */
  free: number;
  baseMs: number;
  maxMs: number;
  /** يُنسى العدّاد بعد هذه المدة بلا فشل (لا تقل عن السقف) */
  forgetMs: number;
}

/** التأخير بعد الفشل رقم n: صفر حتى المجاني، ثم الأساس × 2^(n − المجاني − 1) حتى السقف. */
export function backoffDelayMs(n: number, p: BackoffPolicy): number {
  if (n <= p.free) return 0;
  return Math.min(p.maxMs, p.baseMs * 2 ** Math.min(n - p.free - 1, 30));
}

// العدّاد والموعد في Redis بساعة Redis نفسها، فلا تختلف النسخ بساعاتها. الموعد عدد صحيح بالميلي ثانية.
const BACKOFF_RECORD = `local n = redis.call('HINCRBY', KEYS[1], 'n', 1)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local free, base, max, forget = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
if n > free then
  local e = n - free - 1
  if e > 30 then e = 30 end
  local d = base * (2 ^ e)
  if d > max then d = max end
  redis.call('HSET', KEYS[1], 'until', string.format('%d', math.floor(now + d)))
end
redis.call('PEXPIRE', KEYS[1], forget)
return n`;
const BACKOFF_WAIT = `local u = redis.call('HGET', KEYS[1], 'until')
if not u then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local left = tonumber(u) - now
if left < 0 then return 0 end
return left`;

/**
 * عدّاد فشل بتأخير متضاعف (ADR 0113)، لكل حساب لا لكل عنوان: لا يغلق الحساب بل يؤخر المحاولة التالية بعد المجاني، والسقف
 * يحدّ ما يملكه مهاجم من إبقاء صاحب الحساب خارجه. المفاتيح HMAC كبقية المحدّدات.
 */
export class RedisBackoffLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly policy: BackoffPolicy,
    private readonly keyMaterial: Buffer,
  ) {}

  private key(raw: string): string {
    return `bo:${this.name}:${createHmac('sha256', this.keyMaterial).update(raw).digest('hex')}`;
  }

  async retryAfter(raw: string): Promise<number> {
    const left = Number(await this.redis.eval(BACKOFF_WAIT, 1, this.key(raw)));
    return left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0;
  }

  async record(raw: string): Promise<void> {
    const p = this.policy;
    await this.redis.eval(BACKOFF_RECORD, 1, this.key(raw), p.free, p.baseMs, p.maxMs, Math.max(p.forgetMs, p.maxMs));
  }

  async reset(raw: string): Promise<void> {
    await this.redis.del(this.key(raw));
  }
}

/** العدّاد المتضاعف في ذاكرة النسخة: احتياط عند تعطل Redis بالسياسة نفسها. */
export class MemoryBackoffLimiter implements RateLimiter {
  private readonly hits = new Map<string, { n: number; until: number; forgetAt: number }>();

  constructor(
    private readonly policy: BackoffPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  async retryAfter(key: string): Promise<number> {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || e.forgetAt <= t || e.until <= t) return 0;
    return Math.max(1, Math.ceil((e.until - t) / 1000));
  }

  async record(key: string): Promise<void> {
    const t = this.now();
    const prev = this.hits.get(key);
    const n = prev && prev.forgetAt > t ? prev.n + 1 : 1;
    const delay = backoffDelayMs(n, this.policy);
    this.hits.set(key, { n, until: delay > 0 ? t + delay : (prev?.until ?? 0), forgetAt: t + Math.max(this.policy.forgetMs, this.policy.maxMs) });
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.forgetAt <= t) this.hits.delete(k);
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}

/** مفتاح HMAC لمفاتيح حد المعدل، مشتق (HKDF) من سر الخادم فلا يُضاف سر جديد ولا يُستعمل السر نفسه مباشرة. */
export function rateLimitKeyMaterial(serverSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', serverSecret, Buffer.alloc(0), 'post-history/login-rate-limit-keys', 32));
}

export interface RateLimiter {
  retryAfter(key: string): Promise<number>;
  record(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/** نافذة ثابتة في ذاكرة النسخة: احتياط عند تعطل Redis، بالحدود نفسها لكن لكل نسخة على حدة. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async retryAfter(key: string): Promise<number> {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= t || e.count < this.max) return 0;
    return Math.max(1, Math.ceil((e.resetAt - t) / 1000));
  }

  async record(key: string): Promise<void> {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count += 1;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}

/**
 * Redis أولًا؛ عند تعطله يتراجع إلى الذاكرة بالحدود نفسها (لا fail-open)، ويعود إلى Redis تلقائيًا حين يجيب.
 * الانتقالان يُبلَّغ عنهما مرة واحدة لكل نوبة تعطل لا مع كل طلب.
 */
export class ResilientRateLimiter implements RateLimiter {
  private degraded = false;

  constructor(
    private readonly primary: RateLimiter,
    private readonly fallback: RateLimiter,
    private readonly events: { degraded(err: unknown): void; recovered(): void },
  ) {}

  retryAfter(key: string): Promise<number> {
    return this.run((l) => l.retryAfter(key));
  }

  record(key: string): Promise<void> {
    return this.run((l) => l.record(key));
  }

  reset(key: string): Promise<void> {
    return this.run((l) => l.reset(key));
  }

  private async run<T>(op: (l: RateLimiter) => Promise<T>): Promise<T> {
    try {
      const result = await op(this.primary);
      if (this.degraded) {
        this.degraded = false;
        this.events.recovered();
      }
      return result;
    } catch (err) {
      if (!this.degraded) {
        this.degraded = true;
        this.events.degraded(err);
      }
      return op(this.fallback);
    }
  }
}
