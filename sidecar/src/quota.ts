// Per-key quota: two token buckets, one for requests and one for model tokens. The request bucket is charged
// when a request is admitted; the token bucket admits while it holds at least one token and is charged afterwards
// with the usage the upstream reported (it may go negative, down to minus its capacity, so one large response
// cannot lock a key out for long).

export type BucketConfig = { requestsPerMinute?: number; burst?: number; tokensPerMinute?: number; tokenBurst?: number };

class Bucket {
  tokens: number;
  last: number;
  constructor(
    readonly capacity: number,
    readonly perSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }
  refill(now: number) {
    const dt = Math.max(0, now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.perSec);
    this.last = now;
  }
  /** Seconds until `need` tokens are available. */
  waitFor(need: number) {
    return this.tokens >= need ? 0 : (need - this.tokens) / this.perSec;
  }
}

class KeyState {
  requests: Bucket | null = null;
  tokens: Bucket | null = null;
  constructor(cfg: BucketConfig, now: number) {
    if (cfg.requestsPerMinute) this.requests = new Bucket(cfg.burst ?? cfg.requestsPerMinute, cfg.requestsPerMinute / 60, now);
    if (cfg.tokensPerMinute) this.tokens = new Bucket(cfg.tokenBurst ?? cfg.tokensPerMinute, cfg.tokensPerMinute / 60, now);
  }
}

export type Admission = { ok: true } | { ok: false; retryAfterSec: number; scope: "key" | "global" };

export class QuotaManager {
  private keys = new Map<string, KeyState>();
  private global: KeyState;
  constructor(
    private policy: { default: BucketConfig; global: BucketConfig; overrides: Map<string, BucketConfig> },
    private now: () => number = Date.now,
    private maxKeys = 10_000,
  ) {
    this.global = new KeyState(policy.global, now());
  }

  private state(keyId: string): KeyState {
    let s = this.keys.get(keyId);
    if (s) {
      this.keys.delete(keyId); // refresh LRU position
    } else {
      s = new KeyState(this.policy.overrides.get(keyId) ?? this.policy.default, this.now());
      if (this.keys.size >= this.maxKeys) this.keys.delete(this.keys.keys().next().value as string);
    }
    this.keys.set(keyId, s);
    return s;
  }

  private wait(s: KeyState, t: number): number {
    s.requests?.refill(t);
    s.tokens?.refill(t);
    return Math.max(s.requests ? s.requests.waitFor(1) : 0, s.tokens ? s.tokens.waitFor(1) : 0);
  }

  /** Admit one request for `keyId`, charging it. Nothing is charged when the request is refused. */
  admit(keyId: string): Admission {
    const t = this.now();
    const k = this.state(keyId);
    const keyWait = this.wait(k, t);
    const globalWait = this.wait(this.global, t);
    if (keyWait > 0 || globalWait > 0) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(Math.max(keyWait, globalWait))), scope: keyWait >= globalWait ? "key" : "global" };
    }
    if (k.requests) k.requests.tokens -= 1;
    if (this.global.requests) this.global.requests.tokens -= 1;
    return { ok: true };
  }

  /** Charge model tokens the upstream reported for a completed request. */
  charge(keyId: string, tokens: number) {
    if (!(tokens > 0)) return;
    for (const s of [this.state(keyId), this.global]) {
      if (s.tokens) s.tokens.tokens = Math.max(-s.tokens.capacity, s.tokens.tokens - tokens);
    }
  }

  get trackedKeys() {
    return this.keys.size;
  }
}
