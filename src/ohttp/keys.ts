import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { ohttpKeys } from "../db/schema.ts";
import { decrypt, encrypt, log, sha256 } from "../lib/util.ts";
import { keyPublished } from "../tlog/hooks.ts";
import { KEM_X25519, generateGatewayKey, loadGatewayKey, parseKeyConfig, type KeyConfigWithPrivate, type PublicKeyConfig } from "./ohttp.ts";

// Gateway HPKE keys, one per epoch.
//
// Epoch e covers [e * epochSeconds, (e + 1) * epochSeconds) since the Unix epoch. The gateway serves the current
// epoch's key and opens requests to it until OHTTP_KEY_GRACE_SECONDS after the epoch ends, so a client that fetched
// the key just before the boundary still gets through. The next epoch's key is created ahead of time and appears in
// the published key list (status "upcoming") before any client is told to use it. When an epoch's window ends the
// private half is destroyed; the public half and its key configuration stay in the history forever.
//
// The 8-bit key identifier of a configuration is the epoch modulo 256, so replicas agree on it without
// coordination; the configured grace period is capped so two live keys never share one.

export type GatewayKey = typeof ohttpKeys.$inferSelect;
export type KeyStatus = "upcoming" | "current" | "grace" | "expired" | "revoked";

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export const keyIdOfEpoch = (epoch: number) => ((epoch % 256) + 256) % 256;

export class OhttpKeys {
  /** Test hook: the clock. */
  now: () => number = () => Date.now();
  private readonly imported = new Map<number, Promise<KeyConfigWithPrivate>>();
  private readonly creating = new Map<number, Promise<number>>();
  private readyThrough = -1;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  private get epochMs() {
    return this.cfg.ohttp.keyEpochSeconds * 1000;
  }

  epochAt(ms = this.now()) {
    return Math.floor(ms / this.epochMs);
  }

  /** When epoch e's key starts being served, and when it stops being accepted. */
  window(epoch: number) {
    return { validFrom: new Date(epoch * this.epochMs), acceptUntil: new Date((epoch + 1) * this.epochMs + this.cfg.ohttp.keyGraceSeconds * 1000) };
  }

  status(k: GatewayKey, at = this.now()): KeyStatus {
    if (k.revokedAt) return "revoked";
    if (at < k.validFrom.getTime()) return "upcoming";
    if (at >= k.acceptUntil.getTime()) return "expired";
    return this.epochAt(at) === k.epoch ? "current" : "grace";
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  /** Create the keys for the current and the next epoch if they do not exist. Idempotent, safe under concurrency. */
  async ensureCurrent(): Promise<void> {
    const epoch = this.epochAt();
    if (epoch + 1 <= this.readyThrough) return;
    await this.ensureEpoch(epoch);
    await this.ensureEpoch(epoch + 1);
    this.readyThrough = epoch + 1;
  }

  /** Returns how many keys this call created (0 or 1). */
  ensureEpoch(epoch: number): Promise<number> {
    let p = this.creating.get(epoch);
    if (!p) {
      p = this.createMissing(epoch).finally(() => this.creating.delete(epoch));
      this.creating.set(epoch, p);
    }
    return p;
  }

  private async createMissing(epoch: number): Promise<number> {
    const [have] = await this.db.select({ epoch: ohttpKeys.epoch }).from(ohttpKeys).where(eq(ohttpKeys.epoch, epoch));
    if (have) return 0;
    const keyId = keyIdOfEpoch(epoch);
    const key = await generateGatewayKey(keyId);
    const rows = await this.db
      .insert(ohttpKeys)
      .values({
        epoch,
        keyId,
        kemId: KEM_X25519,
        publicKey: b64u(key.publicKey),
        config: b64u(key.config),
        configSha256: sha256(key.config),
        privateEnc: encrypt(this.cfg.appSecret, Buffer.from(key.privateKey).toString("base64")),
        ...this.window(epoch),
      })
      .onConflictDoNothing()
      .returning({ epoch: ohttpKeys.epoch });
    if (rows.length) keyPublished(this.db, "ohttp_key_config"); // transparency log (a no-op unless TLOG_ENABLED)
    return rows.length; // another process may have created this epoch first: then nothing is added
  }

  /**
   * Create the current and next epoch's keys, and destroy the private half of every key whose window has ended or
   * that was revoked. Run by the `ohttp-key-rotation` job; safe to run at any time.
   */
  async rotate(): Promise<{ epoch: number; created: number; destroyed: number }> {
    const epoch = this.epochAt();
    const created = (await this.ensureEpoch(epoch)) + (await this.ensureEpoch(epoch + 1));
    this.readyThrough = Math.max(this.readyThrough, epoch + 1);
    const gone = await this.db
      .update(ohttpKeys)
      .set({ privateEnc: null })
      .where(and(isNotNull(ohttpKeys.privateEnc), or(lte(ohttpKeys.acceptUntil, new Date(this.now())), isNotNull(ohttpKeys.revokedAt))))
      .returning({ epoch: ohttpKeys.epoch });
    for (const g of gone) this.imported.delete(g.epoch);
    if (created || gone.length) log.info("ohttp gateway keys rotated", { epoch, created, destroyed: gone.length });
    return { epoch, created, destroyed: gone.length };
  }

  /** Stop accepting one epoch's key (a compromised key) and destroy its private half. */
  async revokeEpoch(epoch: number): Promise<number> {
    const rows = await this.db
      .update(ohttpKeys)
      .set({ revokedAt: new Date(this.now()), privateEnc: null })
      .where(and(eq(ohttpKeys.epoch, epoch), isNull(ohttpKeys.revokedAt)))
      .returning({ epoch: ohttpKeys.epoch });
    this.imported.delete(epoch);
    return rows.length;
  }

  // ---- what to publish and what to accept ----------------------------------------------------------------------

  /** The key clients are told to use: the current epoch's, or the next one's when the current one was revoked. */
  async serving(): Promise<GatewayKey | null> {
    await this.ensureCurrent();
    const epoch = this.epochAt();
    const rows = await this.db.select().from(ohttpKeys).where(or(eq(ohttpKeys.epoch, epoch), eq(ohttpKeys.epoch, epoch + 1))).orderBy(asc(ohttpKeys.epoch));
    return rows.find((r) => !r.revokedAt && r.privateEnc) ?? null;
  }

  /** Keys that may still open a request naming this key identifier, newest first. */
  async accepting(keyId: number): Promise<GatewayKey[]> {
    await this.ensureCurrent();
    return this.db
      .select()
      .from(ohttpKeys)
      .where(and(eq(ohttpKeys.keyId, keyId), isNotNull(ohttpKeys.privateEnc), isNull(ohttpKeys.revokedAt), gt(ohttpKeys.acceptUntil, new Date(this.now()))))
      .orderBy(desc(ohttpKeys.epoch));
  }

  /** The key, ready to open requests (its private half imported from the encrypted copy, once per process). */
  privateKey(k: GatewayKey): Promise<KeyConfigWithPrivate> {
    // Do not keep an imported key past its window in this process either (the stored copy is destroyed by rotate()).
    const t = this.now();
    for (const e of this.imported.keys()) if (this.window(e).acceptUntil.getTime() <= t) this.imported.delete(e);
    let p = this.imported.get(k.epoch);
    if (!p) {
      if (!k.privateEnc) return Promise.reject(new Error("private key was destroyed"));
      p = loadGatewayKey(k.keyId, unb64u(k.publicKey), new Uint8Array(Buffer.from(decrypt(this.cfg.appSecret, k.privateEnc), "base64")));
      this.imported.set(k.epoch, p);
      p.catch(() => this.imported.delete(k.epoch));
    }
    return p;
  }

  /** The public key configuration clients are given for this key. */
  static config(k: GatewayKey): PublicKeyConfig {
    return parseKeyConfig(unb64u(k.config));
  }

  /** All keys ever created, oldest first (the public halves are never deleted). */
  history(): Promise<GatewayKey[]> {
    return this.db.select().from(ohttpKeys).orderBy(asc(ohttpKeys.epoch));
  }
}

// ---- the append-only key log -------------------------------------------------------------------------------------

const GENESIS = Buffer.alloc(32);

/** entry = SHA-256("ohttp-key-log/v1" 0x00 prev epoch key_id kem_id config_sha256 valid_from_ms accept_until_ms). */
export function logEntryHash(prev: Uint8Array, k: Pick<GatewayKey, "epoch" | "keyId" | "kemId" | "configSha256" | "validFrom" | "acceptUntil">): Buffer {
  const head = Buffer.alloc(8 + 1 + 2);
  head.writeBigUInt64BE(BigInt(k.epoch));
  head[8] = k.keyId;
  head.writeUInt16BE(k.kemId, 9);
  const times = Buffer.alloc(16);
  times.writeBigUInt64BE(BigInt(k.validFrom.getTime()));
  times.writeBigUInt64BE(BigInt(k.acceptUntil.getTime()), 8);
  return createHash("sha256").update("ohttp-key-log/v1\0").update(prev).update(head).update(Buffer.from(k.configSha256, "hex")).update(times).digest();
}

/** The chain over a key history: one entry hash per key, each committing to everything before it. */
export function keyLog(history: GatewayKey[]): { entries: { epoch: number; entry_hash: string }[]; head: string } {
  let prev: Buffer = GENESIS;
  const entries = history.map((k) => {
    prev = logEntryHash(prev, k);
    return { epoch: k.epoch, entry_hash: prev.toString("hex") };
  });
  return { entries, head: prev.toString("hex") };
}

export const GENESIS_HASH = GENESIS.toString("hex");
