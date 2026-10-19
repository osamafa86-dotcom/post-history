import type Redis from 'ioredis';
import { sha256 } from '../common/crypto';

// زيادة ذرية تضبط عمر النافذة عند أول محاولة فقط (نافذة ثابتة).
const RECORD = `local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return c`;

/**
 * حد معدل بنافذة ثابتة في Redis، مشترك بين كل نسخ الخادم. يعدّ ما يسجّله المستدعي فقط (المحاولات الفاشلة).
 * المفاتيح مجزّأة: لا بريد ولا عنوان IP خامًا في Redis.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly name: string,
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private key(raw: string): string {
    return `rl:${this.name}:${sha256(raw).toString('hex')}`;
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
