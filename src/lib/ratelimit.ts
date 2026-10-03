// Fixed-window counters for requests/minute and tokens/minute. In-process by default;
// Redis-backed when REDIS_URL is set so limits hold across router replicas.

export interface RateLimiter {
  take(key: string, amount: number, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfterMs: number; remaining: number }>;
  close(): Promise<void>;
}

export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { start: number; used: number }>();
  private sweep = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [k, w] of this.windows) if (w.start < cutoff) this.windows.delete(k);
  }, 60_000);
  constructor(private readonly now: () => number = () => Date.now()) {
    this.sweep.unref?.();
  }
  async take(key: string, amount: number, limit: number, windowMs: number) {
    if (!limit || limit <= 0) return { ok: true, retryAfterMs: 0, remaining: Infinity };
    const now = this.now();
    const start = now - (now % windowMs);
    const w = this.windows.get(key);
    const cur = w && w.start === start ? w : { start, used: 0 };
    if (cur.used + amount > limit) return { ok: false, retryAfterMs: start + windowMs - now, remaining: Math.max(0, limit - cur.used) };
    cur.used += amount;
    this.windows.set(key, cur);
    return { ok: true, retryAfterMs: 0, remaining: limit - cur.used };
  }
  async close() {
    clearInterval(this.sweep);
  }
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: import("ioredis").Redis) {}
  async take(key: string, amount: number, limit: number, windowMs: number) {
    if (!limit || limit <= 0) return { ok: true, retryAfterMs: 0, remaining: Infinity };
    const now = Date.now();
    const start = now - (now % windowMs);
    const k = `rl:${key}:${start}`;
    const used = await this.redis.incrby(k, amount);
    if (used === amount) await this.redis.pexpire(k, windowMs + 1000);
    if (used > limit) {
      await this.redis.decrby(k, amount);
      return { ok: false, retryAfterMs: start + windowMs - now, remaining: Math.max(0, limit - (used - amount)) };
    }
    return { ok: true, retryAfterMs: 0, remaining: limit - used };
  }
  async close() {}
}
