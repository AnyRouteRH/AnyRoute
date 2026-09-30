import { randomBytes, randomInt } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The blind tokens you have bought, in one JSON file (~/.anyroute/tokens.json, or $ANYROUTE_HOME/tokens.json) that only
// you can read: the file is written with mode 0600 in a directory of mode 0700. A token is a bearer credential. Whoever
// reads it can spend it, so it is never printed, logged or sent anywhere but to the router's onion service.
//
// Every token is spent at most once. A call takes ("leases") a token out of `tokens` and records it in `unconfirmed`
// on disk before anything is sent; afterwards it is either removed for good (the router took it, or refused it as
// spent or invalid) or put back (the router said it did not take it, or nothing was sent). A token whose call was
// sent and then lost stays in `unconfirmed`: it may or may not have been spent, and it is never used again.
//
// Reads and writes go through a lock file, so `buy` and a running `start` can share the file, and a write replaces the
// file atomically, so a crash never leaves half a file.

export type StoredToken = {
  /** The token as it goes into `Authorization: PrivateToken token=...` (base64url). */
  token: string;
  key_id: string;
  denomination: number;
  epoch: number;
  /** What one token is worth in USD, as the router published it when the token was bought. */
  value_usd: string;
  /** The last moment the router accepts the token. */
  redeem_until: string;
  bought_at: string;
};
export type Unconfirmed = StoredToken & { sent_at: string };
type Doc = { version: 1; tokens: StoredToken[]; unconfirmed: Unconfirmed[] };

export type Lease = { readonly token: StoredToken };
export type Summary = { usable: number; expired: number; unconfirmed: number; byDenomination: Record<string, number>; nextExpiry: string | null; valueUsd: string };

export class StoreError extends Error {
  override name = "StoreError";
}

/** Where the state lives: $ANYROUTE_HOME, else ~/.anyroute. */
export const stateDir = (env: Record<string, string | undefined> = process.env) => env.ANYROUTE_HOME?.trim() || path.join(os.homedir(), ".anyroute");

const EMPTY = (): Doc => ({ version: 1, tokens: [], unconfirmed: [] });
const posix = process.platform !== "win32";
/** A token is not offered in its last minute: the call would reach the router after it expired. */
const EXPIRY_MARGIN_MS = 60_000;

function validToken(t: unknown): t is StoredToken {
  const o = t as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o.token === "string" &&
    /^[A-Za-z0-9_-]{300,}$/.test(o.token) &&
    typeof o.key_id === "string" &&
    Number.isInteger(o.denomination) &&
    Number.isInteger(o.epoch) &&
    typeof o.value_usd === "string" &&
    typeof o.redeem_until === "string" &&
    !Number.isNaN(Date.parse(o.redeem_until)) &&
    typeof o.bought_at === "string"
  );
}

export class TokenStore {
  readonly file: string;
  private readonly lockFile: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {
    this.file = path.join(dir, "tokens.json");
    this.lockFile = path.join(dir, "tokens.lock");
  }

  // ---- reading and writing -------------------------------------------------------------------------------------

  private async load(): Promise<Doc> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY();
      throw new StoreError(`Cannot read ${this.file}: ${(e as Error).message}`);
    }
    if (posix) {
      const { mode } = await fs.stat(this.file);
      if (mode & 0o077) {
        await fs.chmod(this.file, 0o600);
        this.warn(`${this.file} was readable by other users; it is now mode 0600.`);
      }
    }
    let doc: Partial<Doc>;
    try {
      doc = JSON.parse(text) as Partial<Doc>;
    } catch {
      throw new StoreError(`${this.file} is not valid JSON. It was left as it is; move it aside to start a new one.`);
    }
    if (doc.version !== 1 || !Array.isArray(doc.tokens) || !Array.isArray(doc.unconfirmed) || !doc.tokens.every(validToken) || !doc.unconfirmed.every(validToken))
      throw new StoreError(`${this.file} is not a token file this version understands. It was left as it is.`);
    return doc as Doc;
  }

  private async save(doc: Doc) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.tokens.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await fs.writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
      if (posix) await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, this.file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw new StoreError(`Cannot write ${this.file}: ${(e as Error).message}`);
    }
  }

  /** Run `fn` on the current contents while holding the lock; save what it returns as changed. */
  private locked<T>(fn: (doc: Doc) => { doc?: Doc; result: T }): Promise<T> {
    const run = async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const release = await this.acquire();
      try {
        const { doc, result } = fn(await this.load());
        if (doc) await this.save(doc);
        return result;
      } finally {
        await release();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async acquire(): Promise<() => Promise<void>> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const handle = await fs.open(this.lockFile, "wx", 0o600);
        await handle.close();
        return () => fs.rm(this.lockFile, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new StoreError(`Cannot lock ${this.file}: ${(e as Error).message}`);
      }
      // A lock older than a few seconds belongs to a process that died in the middle of a write.
      const age = await fs.stat(this.lockFile).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 15_000) await fs.rm(this.lockFile, { force: true });
      else if (Date.now() > deadline) throw new StoreError(`${this.file} is in use by another anyroute-private process.`);
      else await new Promise((r) => setTimeout(r, 15 + Math.random() * 30));
    }
  }

  // ---- operations ----------------------------------------------------------------------------------------------

  /** Add tokens just bought. Tokens that have expired are dropped, since the router no longer takes them. */
  add(tokens: StoredToken[], now = new Date()): Promise<void> {
    return this.locked((doc) => ({
      doc: { ...doc, tokens: [...doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime()), ...tokens] },
      result: undefined,
    }));
  }

  /**
   * Take one usable token for a call: among those that expire soonest, a random one. It moves to `unconfirmed` on disk
   * before this returns, so a crash after this point can never lead to the token being sent twice. Null when none is left.
   */
  lease(now = new Date()): Promise<Lease | null> {
    return this.locked((doc) => {
      const usable = doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime() + EXPIRY_MARGIN_MS);
      if (!usable.length) return { result: null };
      const soonest = Math.min(...usable.map((t) => Date.parse(t.redeem_until)));
      const pool = usable.filter((t) => Date.parse(t.redeem_until) === soonest);
      const picked = pool[randomInt(pool.length)];
      return {
        doc: { ...doc, tokens: doc.tokens.filter((t) => t !== picked), unconfirmed: [...doc.unconfirmed, { ...picked, sent_at: now.toISOString() }] },
        result: { token: picked },
      };
    });
  }

  /**
   * Record what became of a leased token: "consumed" (the router took it, or refused it as spent or invalid; it is
   * gone) or "returned" (nothing was sent, or the router says it did not take it; it can be used again).
   */
  settle(lease: Lease, outcome: "consumed" | "returned"): Promise<void> {
    return this.locked((doc) => {
      const held = doc.unconfirmed.find((t) => t.token === lease.token.token);
      if (!held) return { result: undefined };
      const { sent_at: _sent, ...token } = held;
      return {
        doc: { ...doc, unconfirmed: doc.unconfirmed.filter((t) => t !== held), tokens: outcome === "returned" ? [token, ...doc.tokens] : doc.tokens },
        result: undefined,
      };
    });
  }

  /** Counts for `status` and the start-up banner. Never includes a token. Reads only: it creates nothing. */
  async summary(now = new Date()): Promise<Summary> {
    const doc = await this.load();
    const live = doc.tokens.filter((t) => Date.parse(t.redeem_until) > now.getTime() + EXPIRY_MARGIN_MS);
    const byDenomination: Record<string, number> = {};
    for (const t of live) byDenomination[t.denomination] = (byDenomination[t.denomination] ?? 0) + 1;
    const next = live.length ? new Date(Math.min(...live.map((t) => Date.parse(t.redeem_until)))).toISOString() : null;
    // Micro-dollars as an integer, so the sum is exact.
    const micro = live.reduce((sum, t) => sum + Math.round(Number(t.value_usd) * 1e6), 0);
    return { usable: live.length, expired: doc.tokens.length - live.length, unconfirmed: doc.unconfirmed.length, byDenomination, nextExpiry: next, valueUsd: (micro / 1e6).toFixed(4) };
  }
}
