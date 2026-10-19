// حد معدل بنافذة ثابتة في الذاكرة. يكفي لنسخة خادم واحدة في التأسيس؛ عند تعدد النسخ يُنقل إلى Redis.
export class FixedWindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** يسجّل محاولة؛ يعيد ثواني الانتظار إن تجاوز المفتاح الحد، وإلا 0. */
  hit(key: string): number {
    const t = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (this.hits.size > 10_000) this.sweep(t);
    return entry.count > this.max ? Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) : 0;
  }

  private sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
