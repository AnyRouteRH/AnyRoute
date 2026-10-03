// The commerce ledger's rules, as pure functions over settlements the sources (sources.ts) read. Nothing here reads a
// database or the chain, and nothing it returns names a payer, a payee, an amount of one settlement or a transaction:
// only counts, sums and medians over a window.
//
// A settlement counts toward the filtered figures only when every rule below passes, checked in this order (the first
// rule that fails is the reason it is excluded; each excluded settlement is counted under exactly one reason):
//   unanchored    its receipt is not in a root confirmed on ReceiptAnchor (or it has no receipt at all)
//   same_owner    payer and payee are the same wallet, resolve to the same owner key, or are both operator wallets
//   round_trip    value went back from the payee to the payer within 24 hours, as a settlement or a plain transfer
//   funding_link  payer and payee are linked by USDG funding within N transfers (only when the transfer index is on)

export const COMMERCE_KINDS = [
  { kind: "model.call", label: "Model calls (x402)" },
  { kind: "tool.call", label: "Tool calls" },
  { kind: "facilitator.settle", label: "Facilitator settlements" },
  { kind: "job.release", label: "Job releases" },
] as const;

export const EXCLUSIONS = ["unanchored", "same_owner", "round_trip", "funding_link"] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

export const WINDOWS = [
  { name: "24h", ms: 86_400_000 },
  { name: "7d", ms: 7 * 86_400_000 },
  { name: "30d", ms: 30 * 86_400_000 },
] as const;
export type WindowName = (typeof WINDOWS)[number]["name"];

export const ROUND_TRIP_MS = 86_400_000;
/** Settlements older than the longest window, still read so a round trip across its start is seen. */
export const LOOKBACK_MS = WINDOWS[WINDOWS.length - 1].ms + ROUND_TRIP_MS;

/** One settled payment, as a source reports it. Identities are lowercase 0x addresses or opaque source-scoped ids. */
export type Settlement = {
  kind: string;
  payer: string;
  payee: string;
  /** USDG base units (6 decimals) that moved from payer to payee. */
  amountUsdg: bigint;
  at: Date;
  /** Every receipt for this settlement sits in a root confirmed on ReceiptAnchor. */
  anchored: boolean;
  refunded: boolean;
  /** The owner key behind each side, when the router knows it. Equal non-null owners are the same owner. */
  payerOwner?: string | null;
  payeeOwner?: string | null;
  /** The on-chain transaction that moved the money, when there is one. It never counts as funding. */
  txHash?: string | null;
};

/** What the transfer index says about two wallets (funding.ts). */
export type FundingView = {
  /** Linked by USDG funding within the configured number of hops. */
  linked(a: string, b: string): boolean;
  /** A plain (non-settlement) transfer from `from` to `to` within `withinMs` of `at`. */
  returned(from: string, to: string, at: Date, withinMs: number): boolean;
};

export const isAddress = (v: string) => /^0x[0-9a-f]{40}$/.test(v);

/**
 * The reason each settlement is excluded, or null when it counts. Same order as the input. `operators` are the wallets
 * the operator controls: a payment between two of them is the operator paying itself.
 */
export function classify(settlements: Settlement[], funding: FundingView | null, operators: ReadonlySet<string> = new Set()): (Exclusion | null)[] {
  // Times of settlements per direction, for the round-trip rule.
  const byPair = new Map<string, number[]>();
  for (const s of settlements) {
    const k = `${s.payer}>${s.payee}`;
    const list = byPair.get(k);
    if (list) list.push(s.at.getTime());
    else byPair.set(k, [s.at.getTime()]);
  }
  const reverseWithin = (s: Settlement) => (byPair.get(`${s.payee}>${s.payer}`) ?? []).some((t) => Math.abs(t - s.at.getTime()) <= ROUND_TRIP_MS);
  return settlements.map((s) => {
    if (!s.anchored) return "unanchored";
    if (s.payer === s.payee || (s.payerOwner != null && s.payerOwner === s.payeeOwner) || (operators.has(s.payer) && operators.has(s.payee))) return "same_owner";
    if (reverseWithin(s)) return "round_trip";
    const onChain = isAddress(s.payer) && isAddress(s.payee);
    if (funding && onChain && funding.returned(s.payee, s.payer, s.at, ROUND_TRIP_MS)) return "round_trip";
    if (funding && onChain && funding.linked(s.payer, s.payee)) return "funding_link";
    return null;
  });
}

export type Figures = {
  settlements: number;
  payers: number;
  payees: number;
  /** USDG base units, as a decimal string. */
  volume_usdg: string;
  /** The middle settlement amount (the floor of the mean of the two middle ones for an even count); null when none. */
  median_price_usdg: string | null;
  refunds: number;
  /** Refunded settlements over settlements, to four decimals; null when there are none. */
  refund_rate: number | null;
};
export type Block = { gross: Figures; filtered: Figures; excluded: Record<Exclusion, number> };

/** Exact median of amounts in USDG base units. */
export function median(values: bigint[]): bigint | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2n;
}

export function figures(list: Settlement[]): Figures {
  const refunds = list.filter((s) => s.refunded).length;
  const med = median(list.map((s) => s.amountUsdg));
  return {
    settlements: list.length,
    payers: new Set(list.map((s) => s.payer)).size,
    payees: new Set(list.map((s) => s.payee)).size,
    volume_usdg: list.reduce((sum, s) => sum + s.amountUsdg, 0n).toString(),
    median_price_usdg: med === null ? null : med.toString(),
    refunds,
    refund_rate: list.length ? Math.round((refunds / list.length) * 10_000) / 10_000 : null,
  };
}

export function block(list: Settlement[], reasons: (Exclusion | null)[]): Block {
  const excluded = Object.fromEntries(EXCLUSIONS.map((r) => [r, 0])) as Record<Exclusion, number>;
  reasons.forEach((r) => r && excluded[r]++);
  return { gross: figures(list), filtered: figures(list.filter((_, i) => reasons[i] === null)), excluded };
}

export type WindowReport = { from: string; to: string; total: Block; kinds: Record<string, Block> };

/**
 * Figures per window (24h, 7d, 30d) and per kind, gross and filtered side by side. Every known kind is present, with
 * zeros when nothing of that kind settled; kinds a source reports that are not in COMMERCE_KINDS are kept too.
 */
export function report(settlements: Settlement[], reasons: (Exclusion | null)[], asOf: Date, kinds: string[]): Record<WindowName, WindowReport> {
  const out = {} as Record<WindowName, WindowReport>;
  const allKinds = [...new Set([...kinds, ...settlements.map((s) => s.kind)])];
  for (const w of WINDOWS) {
    const from = asOf.getTime() - w.ms;
    const idx = settlements.flatMap((s, i) => (s.at.getTime() > from && s.at.getTime() <= asOf.getTime() ? [i] : []));
    const pick = (ids: number[]) => block(ids.map((i) => settlements[i]), ids.map((i) => reasons[i]));
    out[w.name] = {
      from: new Date(from).toISOString(),
      to: asOf.toISOString(),
      total: pick(idx),
      kinds: Object.fromEntries(allKinds.map((k) => [k, pick(idx.filter((i) => settlements[i].kind === k))])),
    };
  }
  return out;
}
