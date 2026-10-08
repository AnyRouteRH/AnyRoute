import type { Ctx } from "../context.ts";
import { decrypt, encrypt, sha256, uid } from "../lib/util.ts";

const FINISH_SCRIPT = "if redis['call']('GET', KEYS[1]) == ARGV[1] then return redis['call']('SET', KEYS[1], ARGV[2], 'KEEPTTL') end return 0";

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
export type Result = { status: number; headers: Record<string, string>; body?: string };
type Entry = { hash: string; owner: string; result?: Result };
type MemoryEntry = { sealed: string; expires: number; timer: ReturnType<typeof setTimeout> };

// D145: no early eviction: losing a live entry could charge a retry twice.
export class IdempotencyStore {
  private memory = new Map<string, MemoryEntry>();
  constructor(private secret: string, private redis?: Ctx["cache"]["redis"], private clock = Date.now, private capacity = 5_000) {}
  ref(account: string, key: string, id: string) { return `idempotency:${sha256(JSON.stringify([account, key, id]))}`; }
  private seal(ref: string, entry: Entry) { return encrypt(this.secret + ":" + ref, JSON.stringify(entry)); }
  private open(ref: string, sealed: string): Entry { return JSON.parse(decrypt(this.secret + ":" + ref, sealed)); }
  private sweep() {
    for (const [ref, entry] of this.memory) if (entry.expires <= this.clock()) { clearTimeout(entry.timer); this.memory.delete(ref); }
  }
  async claim(ref: string, hash: string): Promise<{ first: boolean; entry: Entry; sealed: string }> {
    const entry: Entry = { hash, owner: uid() };
    const sealed = this.seal(ref, entry);
    if (this.redis) {
      if (await this.redis.set(ref, sealed, "PX", IDEMPOTENCY_TTL_MS, "NX") === "OK") return { first: true, entry, sealed };
      const old = await this.redis.get(ref);
      if (!old) return this.claim(ref, hash); // Expired between SET NX and GET.
      return { first: false, entry: this.open(ref, old), sealed: old };
    }
    this.sweep();
    const old = this.memory.get(ref);
    if (old) return { first: false, entry: this.open(ref, old.sealed), sealed: old.sealed };
    if (this.memory.size >= this.capacity) throw new Error("Idempotency store is full");
    const timer = setTimeout(() => this.memory.delete(ref), IDEMPOTENCY_TTL_MS);
    timer.unref();
    this.memory.set(ref, { sealed, expires: this.clock() + IDEMPOTENCY_TTL_MS, timer });
    return { first: true, entry, sealed };
  }
  async finish(ref: string, claim: { entry: Entry; sealed: string }, result: Result) {
    const sealed = this.seal(ref, { ...claim.entry, result });
    if (this.redis) {
      // A late completion must not replace a new claim after expiry. Preserve the original expiry.
      await this.redis.eval(FINISH_SCRIPT, 1, ref, claim.sealed, sealed);
    } else {
      this.sweep();
      const old = this.memory.get(ref);
      if (old?.sealed === claim.sealed) old.sealed = sealed;
    }
  }
  async sealedAt(ref: string) { this.sweep(); return this.redis ? this.redis.get(ref) : this.memory.get(ref)?.sealed ?? null; }
}

const stores = new WeakMap<Ctx, IdempotencyStore>();
export function idempotencyStore(ctx: Ctx) {
  let store = stores.get(ctx);
  if (!store) stores.set(ctx, store = new IdempotencyStore(ctx.cfg.appSecret, ctx.cache.redis));
  return store;
}
