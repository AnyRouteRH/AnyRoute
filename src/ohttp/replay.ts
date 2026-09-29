// Anti-replay for encapsulated requests (RFC 9458 section 6.5). The encapsulated KEM key (enc) is fresh for every
// request, so a repeated one is a copy of an earlier message, not a second request. This remembers recent ones in
// memory, bounded in count; when it is full the oldest go first. It stops a relay or network observer replaying a
// request to one gateway process. It is not shared between replicas: what makes a replay harmless everywhere is
// that a blind token can be spent once and that a token purchase is idempotent.

export class ReplayGuard {
  private readonly seenAt = new Map<string, number>();

  constructor(
    private readonly capacity = 100_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if this id was already recorded and not yet forgotten; otherwise records it until `ttlMs` from now. */
  seen(id: string, ttlMs: number): boolean {
    const t = this.now();
    const until = this.seenAt.get(id);
    if (until !== undefined) {
      if (until > t) return true;
      this.seenAt.delete(id);
    }
    // Full: forget the oldest inserted (expired entries are only removed when met, so this is O(1)).
    while (this.seenAt.size >= this.capacity) this.seenAt.delete(this.seenAt.keys().next().value as string);
    this.seenAt.set(id, t + ttlMs);
    return false;
  }

  get size() {
    return this.seenAt.size;
  }
}
