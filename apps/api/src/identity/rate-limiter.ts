// حد معدل بنافذة ثابتة في الذاكرة. يكفي لنسخة خادم واحدة في التأسيس؛ عند تعدد النسخ يُنقل إلى Redis.
// يعدّ ما يسجّله المستدعي فقط (المحاولات الفاشلة)، فالدخول الصحيح لا يستهلك الحصة ولا يُقفل صاحب الحساب.
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** ثواني الانتظار إن بلغ المفتاح الحد، وإلا 0. لا يسجّل شيئًا. */
  retryAfter(key: string): number {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t || entry.count < this.max) return 0;
    return Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
  }

  /** يسجّل محاولة فاشلة. */
  record(key: string): void {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.sweep(t);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
