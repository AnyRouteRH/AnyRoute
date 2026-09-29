import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { kv } from "../db/schema.ts";
import { log } from "../lib/util.ts";
import { deliverAlert, resolveFormat } from "./alerts.ts";
import { IPX_DECIMALS, decimalString, ipxSnapshot, type IpxClassDef, type IpxSnapshot } from "./ipx.ts";
import {
  ORACLE_KIND,
  ORACLE_VERSION,
  OracleSigner,
  assess,
  publicKeyOf,
  sameKey,
  signUpdate,
  verificationInstructions,
  type OracleAlgorithm,
  type SignedUpdate,
  type UpdateBody,
} from "./ipx-oracle-sign.ts";
import { HttpsPushPublisher, OnchainFeedPublisher, parsePushConfig } from "./ipx-oracle-push.ts";

export * from "./ipx-oracle-sign.ts";

// The IPX oracle publisher: signed index price updates for a builder-operated oracle, made from the latest IPX samples
// (services/ipx.ts). Off unless IPX_ORACLE_ENABLED. It sends no transaction and makes no outside request unless a sink
// is configured for it: the on-chain sink builds IPXFeed calldata (and submits only with IPX_ORACLE_ONCHAIN_SUBMIT),
// the https sink pushes to the URL an operator configures.
//
// Safety rules, all enforced here and covered by test/ipx-oracle.test.ts:
//   THIN        trailing-24h volume below IPX_THIN_USDG: the update says status "thin" and reduce_only true.
//   stale       every update carries valid_until = timestamp + IPX_ORACLE_STALE_AFTER_S; past it a consumer must halt.
//               When the latest hour has no price the publisher signs nothing, so the last update runs out on its own.
//   move clamp  the published price moves at most IPX_ORACLE_MAX_MOVE_BPS from the previous update; the update says
//               clamp.applied and the operator alert fires.
//   kill switch IPX_ORACLE_HALTED or PUT /api/v1/ipx/oracle/halt: no price is signed or sent to any sink; the latest
//               record becomes a signed halted status.

const KEY = {
  latest: (cls: string) => `ipx-oracle:latest:${cls}`,
  state: (cls: string) => `ipx-oracle:state:${cls}`,
  halt: "ipx-oracle:halt",
};

export type OracleSettings = Config["ipx"]["oracle"];
export type PublishResult = { status: "sent" | "submitted" | "calldata" | "skipped" | "failed"; detail?: string };
export interface OraclePublisher {
  readonly name: string;
  publish(update: SignedUpdate): Promise<PublishResult>;
}
export type OracleAlert = { check: string; state: "failing" | "recovered"; since: string };

export type HaltState = { halted: boolean; reason: string | null; since: number };
export type ClassState = {
  sequence: number;
  /** The last price that was signed and published, the anchor of the move clamp. */
  last_price_e8: string | null;
  last_window_to: number | null;
  alerts: Record<string, boolean>;
  publishers: Record<string, { at: number; status: string; detail: string | null }>;
};
const emptyState = (): ClassState => ({ sequence: 0, last_price_e8: null, last_window_to: null, alerts: {}, publishers: {} });

export interface OracleStore {
  latest(cls: string): Promise<SignedUpdate | null>;
  putLatest(cls: string, update: SignedUpdate): Promise<void>;
  state(cls: string): Promise<ClassState>;
  putState(cls: string, state: ClassState): Promise<void>;
  halt(): Promise<HaltState | null>;
  putHalt(halt: HaltState): Promise<void>;
}

export class MemoryOracleStore implements OracleStore {
  private m = new Map<string, unknown>();
  async latest(cls: string) { return (this.m.get(KEY.latest(cls)) as SignedUpdate | undefined) ?? null; }
  async putLatest(cls: string, u: SignedUpdate) { this.m.set(KEY.latest(cls), structuredClone(u)); }
  async state(cls: string) { return structuredClone((this.m.get(KEY.state(cls)) as ClassState | undefined) ?? emptyState()); }
  async putState(cls: string, s: ClassState) { this.m.set(KEY.state(cls), structuredClone(s)); }
  async halt() { return (this.m.get(KEY.halt) as HaltState | undefined) ?? null; }
  async putHalt(h: HaltState) { this.m.set(KEY.halt, { ...h }); }
}

/** The kv table holds the latest record, the per-class state and the runtime halt flag: no migration. */
export class KvOracleStore implements OracleStore {
  constructor(private db: Db) {}
  private async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db.select({ value: kv.value }).from(kv).where(eq(kv.key, key));
    return (row?.value as T | undefined) ?? null;
  }
  private async put(key: string, value: unknown) {
    await this.db.insert(kv).values({ key, value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: new Date() } });
  }
  latest(cls: string) { return this.get<SignedUpdate>(KEY.latest(cls)); }
  putLatest(cls: string, u: SignedUpdate) { return this.put(KEY.latest(cls), u); }
  async state(cls: string) { return { ...emptyState(), ...((await this.get<ClassState>(KEY.state(cls))) ?? {}) }; }
  putState(cls: string, s: ClassState) { return this.put(KEY.state(cls), s); }
  halt() { return this.get<HaltState>(KEY.halt); }
  putHalt(h: HaltState) { return this.put(KEY.halt, h); }
}

// ---- The rules ------------------------------------------------------------------------------------------

/**
 * Move clamp: the price may move at most `maxMoveBps` from the previous published price in one update. Returns the price
 * to publish and whether the sample was cut back. With no previous price there is nothing to clamp against.
 */
export function clampMove(rawE8: bigint, prevE8: bigint | null, maxMoveBps: number): { priceE8: bigint; clamped: boolean } {
  if (prevE8 === null || prevE8 <= 0n) return { priceE8: rawE8, clamped: false };
  const bps = BigInt(maxMoveBps);
  let hi = (prevE8 * (10_000n + bps)) / 10_000n;
  if (hi <= prevE8) hi = prevE8 + 1n; // a tiny price must still be able to move
  let lo = (prevE8 * (10_000n - bps)) / 10_000n;
  if (lo >= prevE8) lo = prevE8 - 1n;
  if (lo < 1n) lo = 1n;
  if (rawE8 > hi) return { priceE8: hi, clamped: true };
  if (rawE8 < lo && lo < prevE8) return { priceE8: lo, clamped: true };
  return { priceE8: rawE8, clamped: false };
}

/** THIN rule: a thin class is recommended reduce-only. */
export function reduceOnlyFor(thin: boolean): { reduceOnly: boolean; reasons: string[] } {
  return thin ? { reduceOnly: true, reasons: ["thin"] } : { reduceOnly: false, reasons: [] };
}

export type Rules = { staleAfterS: number; maxMoveBps: number };
export type Prior = { lastPriceE8: bigint | null; sequence: number };
export type Decision =
  | { kind: "halted"; body: UpdateBody }
  | { kind: "no_price" }
  | { kind: "update"; body: UpdateBody; clamped: boolean };

const baseBody = (cls: string, nowS: number, prior: Prior, rules: Rules) => ({
  v: ORACLE_VERSION,
  kind: ORACLE_KIND,
  index: `ANYR-IPX/${cls}`,
  class: cls,
  decimals: IPX_DECIMALS,
  unit: "USDG per 1,000,000 tokens",
  timestamp: nowS,
  valid_until: nowS + rules.staleAfterS,
  stale_after_s: rules.staleAfterS,
  sequence: prior.sequence + 1,
}) as const;

/** The whole decision for one class at one moment: halted record, nothing to sign, or a price update. Pure. */
export function decide(i: { cls: string; snapshot: IpxSnapshot | null; halt: { reason: string } | null; prior: Prior; rules: Rules; nowS: number }): Decision {
  const base = baseBody(i.cls, i.nowS, i.prior, i.rules);
  if (i.halt) {
    return {
      kind: "halted",
      body: { ...base, status: "halted", price: null, price_e8: null, thin: null, volume_usdg_24h: null, thin_threshold_usdg: null, reduce_only: true, reduce_only_reasons: ["halted"], halted: true, halt_reason: i.halt.reason, source: null, clamp: null },
    };
  }
  const s = i.snapshot;
  if (!s || s.priceE8 === null) return { kind: "no_price" };
  const { priceE8, clamped } = clampMove(s.priceE8, i.prior.lastPriceE8, i.rules.maxMoveBps);
  const ro = reduceOnlyFor(s.thin);
  return {
    kind: "update",
    clamped,
    body: {
      ...base,
      status: s.thin ? "thin" : "ok",
      price: decimalString(priceE8, IPX_DECIMALS),
      price_e8: priceE8.toString(),
      thin: s.thin,
      volume_usdg_24h: decimalString(s.volumeUsdg24h, 6),
      thin_threshold_usdg: decimalString(s.thinThresholdUsdg, 6),
      reduce_only: ro.reduceOnly,
      reduce_only_reasons: ro.reasons,
      halted: false,
      halt_reason: null,
      source: { window_from: Math.floor(s.window.from.getTime() / 1000), window_to: Math.floor(s.window.to.getTime() / 1000), receipt_root: s.receiptRoot, receipts_in_root: s.receiptsInRoot, raw_price_e8: s.priceE8.toString() },
      clamp: { applied: clamped, max_move_bps: i.rules.maxMoveBps, previous_price_e8: i.prior.lastPriceE8?.toString() ?? null },
    },
  };
}

/** Halt reasons are shown publicly: short printable text only. */
export function cleanReason(v: unknown): string {
  return (typeof v === "string" ? v : "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---- The publisher --------------------------------------------------------------------------------------

export type OracleDeps = {
  classes: IpxClassDef[];
  rules: Rules;
  /** IPX_ORACLE_HALTED. */
  configHalted: boolean;
  store: OracleStore;
  signer: OracleSigner;
  snapshot: (cls: IpxClassDef, now: Date) => Promise<IpxSnapshot>;
  publishers: OraclePublisher[];
  alert: (a: OracleAlert) => Promise<void>;
  now?: () => number;
  publishTimeoutMs?: number;
};

export type TickResult = {
  class: string;
  status: "published" | "halted" | "no_price" | "error";
  sequence?: number;
  clamped?: boolean;
  publishers?: Record<string, string>;
};

export class IpxOracle {
  private snaps = new Map<string, { hour: number; snap: IpxSnapshot }>();
  constructor(private d: OracleDeps) {}

  /** One pass over every class. A class that fails does not stop the others; the pass then reports the failure. */
  async tick(): Promise<TickResult[]> {
    const out: TickResult[] = [];
    let failed = 0;
    for (const cls of this.d.classes) {
      try {
        out.push(await this.tickClass(cls));
      } catch (e) {
        failed++;
        log.error("ipx oracle class failed", { class: cls.id, error: (e as Error).message });
        out.push({ class: cls.id, status: "error" });
      }
    }
    if (failed) throw new Error(`IPX oracle: ${failed} of ${this.d.classes.length} classes failed; inspect private operator logs.`);
    return out;
  }

  private async currentHalt(): Promise<{ reason: string } | null> {
    if (this.d.configHalted) return { reason: "config" };
    const h = await this.d.store.halt();
    return h?.halted ? { reason: cleanReason(h.reason) || "operator" } : null;
  }

  private async snap(cls: IpxClassDef, nowMs: number): Promise<IpxSnapshot> {
    const hour = Math.floor(nowMs / 3_600_000);
    const hit = this.snaps.get(cls.id);
    if (hit && hit.hour === hour && hit.snap.priceE8 !== null) return hit.snap; // a whole hour never changes once it has a price
    const snap = await this.d.snapshot(cls, new Date(nowMs));
    this.snaps.set(cls.id, { hour, snap });
    return snap;
  }

  private async raise(state: ClassState, cls: string, kind: string, active: boolean, nowMs: number) {
    if (!!state.alerts[kind] === active) return;
    state.alerts[kind] = active;
    try {
      await this.d.alert({ check: `ipx_oracle_${kind}_${cls.toLowerCase()}`, state: active ? "failing" : "recovered", since: new Date(nowMs).toISOString() });
    } catch {
      log.warn("ipx oracle alert delivery failed", { class: cls, kind });
    }
  }

  async tickClass(cls: IpxClassDef): Promise<TickResult> {
    const { store, rules } = this.d;
    const nowMs = (this.d.now ?? Date.now)();
    const nowS = Math.floor(nowMs / 1000);
    const [state, latest, halt] = await Promise.all([store.state(cls.id), store.latest(cls.id), this.currentHalt()]);
    const prior: Prior = { lastPriceE8: state.last_price_e8 === null ? null : BigInt(state.last_price_e8), sequence: Math.max(state.sequence, latest?.sequence ?? 0) };

    if (halt) {
      // Freeze: sign one halted record (again only when the reason changes) and touch no sink.
      const same = latest?.status === "halted" && latest.halt_reason === halt.reason;
      let sequence = prior.sequence;
      if (!same) {
        const d = decide({ cls: cls.id, snapshot: null, halt, prior, rules, nowS });
        if (d.kind === "halted") {
          const signed = await signUpdate(this.d.signer, d.body);
          await store.putLatest(cls.id, signed);
          sequence = signed.sequence;
          state.sequence = sequence;
        }
      }
      await this.raise(state, cls.id, "halted", true, nowMs);
      await store.putState(cls.id, state);
      return { class: cls.id, status: "halted", sequence };
    }
    await this.raise(state, cls.id, "halted", false, nowMs);

    const snapshot = await this.snap(cls, nowMs);
    const d = decide({ cls: cls.id, snapshot, halt: null, prior, rules, nowS });
    if (d.kind !== "update") {
      // No price for the latest hour: sign nothing. The previous update keeps its valid_until and then runs out.
      await this.raise(state, cls.id, "no_price", true, nowMs);
      await store.putState(cls.id, state);
      return { class: cls.id, status: "no_price" };
    }
    await this.raise(state, cls.id, "no_price", false, nowMs);

    const signed = await signUpdate(this.d.signer, d.body);
    await store.putLatest(cls.id, signed);
    state.sequence = signed.sequence;
    state.last_price_e8 = signed.price_e8;
    state.last_window_to = signed.source?.window_to ?? null;
    await this.raise(state, cls.id, "clamped", d.clamped, nowMs);

    const results = await this.publish(signed);
    let anyFailed = false;
    for (const [name, r] of Object.entries(results)) {
      state.publishers[name] = { at: nowS, status: r.status, detail: r.detail ?? null };
      if (r.status === "failed") anyFailed = true;
    }
    await this.raise(state, cls.id, "publish_failed", anyFailed, nowMs);
    await store.putState(cls.id, state);
    return { class: cls.id, status: "published", sequence: signed.sequence, clamped: d.clamped, publishers: Object.fromEntries(Object.entries(results).map(([n, r]) => [n, r.status])) };
  }

  /** Every sink gets the update independently; a slow or failing sink cannot block another or the stored record. */
  private async publish(update: SignedUpdate): Promise<Record<string, PublishResult>> {
    const timeoutMs = this.d.publishTimeoutMs ?? 30_000;
    const entries = await Promise.all(
      this.d.publishers.map(async (p): Promise<[string, PublishResult]> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
          return [p.name, await Promise.race([p.publish(update), timeout])];
        } catch (e) {
          log.warn("ipx oracle publisher failed", { publisher: p.name, error: (e as Error).message });
          return [p.name, { status: "failed", detail: "publisher error" }];
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
    return Object.fromEntries(entries);
  }
}

// ---- Wiring ---------------------------------------------------------------------------------------------

/** Operator alerts reuse the readiness alert webhook: check names and states only, never prices or URLs. */
export function webhookAlertSink(ctx: Pick<Ctx, "cfg">, fetchImpl?: typeof fetch): (a: OracleAlert) => Promise<void> {
  return async (a) => {
    log.warn("ipx oracle alert", { check: a.check, state: a.state });
    const url = ctx.cfg.alerts.webhookUrl;
    if (!url) return;
    await deliverAlert(url, resolveFormat(url, ctx.cfg.alerts.webhookFormat), { kind: "alert", environment: ctx.cfg.env, at: a.since, transitions: [{ check: a.check, state: a.state, since: a.since }] }, fetchImpl);
  };
}

/** The public key consumers pin: the configured one, else the one that belongs to the private key. */
export function oraclePublicKey(cfg: OracleSettings): string | null {
  if (cfg.publicKey) return cfg.publicKey;
  return cfg.privateKey ? publicKeyOf(cfg.algorithm, cfg.privateKey) : null;
}

export function buildOracle(ctx: Ctx, extra: { fetch?: typeof fetch; env?: Record<string, string | undefined> } = {}): IpxOracle {
  const cfg = ctx.cfg.ipx.oracle;
  if (!cfg.enabled) throw new Error("The IPX oracle is not enabled.");
  if (!cfg.privateKey) throw new Error("IPX_ORACLE_PRIVATE_KEY is required to publish.");
  const signer = new OracleSigner(cfg.algorithm, cfg.privateKey);
  if (cfg.publicKey && !sameKey(cfg.publicKey, signer.publicKey)) throw new Error("IPX_ORACLE_PUBLIC_KEY does not belong to IPX_ORACLE_PRIVATE_KEY.");
  const env = extra.env ?? (process.env as Record<string, string | undefined>);
  const publishers: OraclePublisher[] = [];
  if (cfg.publishers.includes("onchain")) publishers.push(new OnchainFeedPublisher({ feeds: cfg.feeds, submit: cfg.onchainSubmit, chain: ctx.chain }));
  if (cfg.publishers.includes("https")) {
    const push = parsePushConfig(cfg.pushConfig ?? "", { production: ctx.cfg.production });
    publishers.push(new HttpsPushPublisher({ config: push, oracleSigner: signer, env, production: ctx.cfg.production, fetch: extra.fetch }));
  }
  const classes = ctx.cfg.ipx.classes.filter((c) => cfg.classes.includes(c.id));
  return new IpxOracle({
    classes,
    rules: { staleAfterS: cfg.staleAfterS, maxMoveBps: cfg.maxMoveBps },
    configHalted: cfg.halted,
    store: new KvOracleStore(ctx.db),
    signer,
    snapshot: (cls, now) => ipxSnapshot(ctx, cls, now),
    publishers,
    alert: webhookAlertSink(ctx),
  });
}

const built = new WeakMap<Ctx, IpxOracle>();

/** The worker job. Refuses to run unless the oracle is enabled. */
export async function runIpxOracle(ctx: Ctx) {
  if (!ctx.cfg.ipx.enabled || !ctx.cfg.ipx.oracle.enabled) return { skipped: "ipx oracle not enabled" };
  let o = built.get(ctx);
  if (!o) {
    o = buildOracle(ctx);
    built.set(ctx, o);
  }
  return { classes: await o.tick() };
}

// ---- Reading and the kill switch (API side) ---------------------------------------------------------------

/** What GET /api/v1/ipx/:class/oracle serves: the latest signed record, the state a consumer must act on, and how to check it. */
export async function oracleView(ctx: Pick<Ctx, "cfg" | "db">, cls: IpxClassDef, nowS = Math.floor(Date.now() / 1000), store: OracleStore = new KvOracleStore(ctx.db)) {
  const cfg = ctx.cfg.ipx.oracle;
  const [latest, stored] = await Promise.all([store.latest(cls.id), store.halt()]);
  const halt: { reason: string; since: number } | null = cfg.halted
    ? { reason: "config", since: latest?.status === "halted" ? latest.timestamp : nowS }
    : stored?.halted
      ? { reason: cleanReason(stored.reason) || "operator", since: stored.since }
      : null;
  const a = assess(latest, nowS);
  // A signed halted record with no active halt is what a resume leaves until the next tick: still unusable.
  const status = halt ? "halted" : a.status === "halted" ? "unavailable" : a.status;
  const action = halt ? "halt" : a.consumer_action;
  return {
    class: cls.id,
    index: `ANYR-IPX/${cls.id}`,
    status,
    consumer_action: action,
    halted: !!halt,
    halt,
    stale: a.stale,
    age_s: a.age_s,
    valid_until: latest?.valid_until ?? null,
    update: latest,
    verification: verificationInstructions(cfg.algorithm as OracleAlgorithm, oraclePublicKey(cfg)),
  };
}

/** Set or clear the runtime kill switch. Takes effect on the next tick and on the next read. */
export async function setOracleHalt(store: OracleStore, input: { halted: boolean; reason?: unknown }, nowS = Math.floor(Date.now() / 1000)): Promise<HaltState> {
  const h: HaltState = { halted: input.halted, reason: input.halted ? cleanReason(input.reason) || "operator" : null, since: nowS };
  await store.putHalt(h);
  return h;
}
