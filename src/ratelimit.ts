/** Token bucket per key (balance key hash or client IP). In-memory: one gateway process. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly perMinute: number;
  private readonly burst: number;
  private lastSweep = Date.now();

  constructor(perMinute: number, burst = Math.max(5, Math.ceil(perMinute / 4))) {
    this.perMinute = perMinute;
    this.burst = burst;
  }

  /** Returns 0 if allowed, else seconds to wait. */
  take(key: string, now = Date.now()): number {
    if (now - this.lastSweep > 60_000) this.sweep(now);
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    // A clock that steps back refills nothing, and takes nothing away.
    const elapsed = Math.max(0, now - b.at);
    b.tokens = Math.min(this.burst, b.tokens + elapsed * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return 0;
    }
    this.buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / rate / 1000);
  }

  private sweep(now: number) {
    this.lastSweep = now;
    for (const [k, b] of this.buckets) if (now - b.at > 600_000) this.buckets.delete(k);
  }
}
