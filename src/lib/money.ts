// All money is integer pico-USD (1 USD = 1e12) held in bigint. USDG has 6
// decimals, so 1 USDG base unit = 1e6 pico. Never use floats for balances;
// floats appear only when rendering JSON for OpenRouter-compatible clients.

export const PICO_PER_USD = 10n ** 12n;
export const PICO_PER_USDG_UNIT = 10n ** 6n;
export type Pico = bigint;

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Parse a decimal USD amount exactly. Rounds toward +infinity when more precise than a pico. */
export function usdToPico(value: string | number | bigint, round: "ceil" | "floor" = "ceil"): Pico {
  if (typeof value === "bigint") return value * PICO_PER_USD;
  const text = typeof value === "number" ? numberToPlain(value) : value.trim();
  const m = DECIMAL.exec(text);
  if (!m) throw new Error(`Invalid USD amount: ${value}`);
  const [, neg, whole, frac = "", exp] = m;
  let digits = whole + frac;
  let scale = frac.length - Number(exp ?? 0); // value = digits * 10^-scale
  // value in pico = digits * 10^(12 - scale)
  const shift = 12 - scale;
  let result: bigint;
  if (shift >= 0) {
    result = BigInt(digits) * 10n ** BigInt(shift);
  } else {
    const div = 10n ** BigInt(-shift);
    const n = BigInt(digits);
    const q = n / div;
    const r = n % div;
    result = r === 0n ? q : round === "ceil" ? (neg ? q : q + 1n) : neg ? q + 1n : q;
  }
  return neg ? -result : result;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid USD amount: ${n}`);
  // Up to 20 significant fractional digits; enough for any per-token price.
  const s = n.toString();
  return s;
}

/** Render pico-USD as a plain decimal string with up to 12 fractional digits, trailing zeros trimmed. */
export function picoToUsdString(p: Pico): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  const whole = a / PICO_PER_USD;
  const frac = (a % PICO_PER_USD).toString().padStart(12, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Number for JSON responses (OpenRouter reports cost as a float). */
export const picoToUsd = (p: Pico): number => Number(picoToUsdString(p));

export function picoToUsdg(p: Pico, round: "ceil" | "floor" = "ceil"): bigint {
  const q = p / PICO_PER_USDG_UNIT;
  const r = p % PICO_PER_USDG_UNIT;
  if (r === 0n) return q;
  return round === "ceil" ? (p > 0n ? q + 1n : q) : p > 0n ? q : q - 1n;
}
export const usdgToPico = (units: bigint): Pico => units * PICO_PER_USDG_UNIT;

export function mulBps(p: Pico, bps: number | bigint, round: "ceil" | "floor" = "ceil"): Pico {
  const n = p * BigInt(bps);
  const q = n / 10_000n;
  return round === "ceil" && n % 10_000n !== 0n && n > 0n ? q + 1n : q;
}

export const tokenCost = (tokens: number, picoPerToken: Pico): Pico => BigInt(Math.max(0, Math.ceil(tokens))) * picoPerToken;

export const maxPico = (...xs: Pico[]) => xs.reduce((a, b) => (b > a ? b : a));
export const minPico = (...xs: Pico[]) => xs.reduce((a, b) => (b < a ? b : a));

/** Split an integer total across weights so the parts sum exactly to it (largest-remainder). */
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0n));
  const base = weights.map((w) => (total * w) / sum);
  let rest = total - base.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (rest <= 0n) break;
    base[i] += 1n;
    rest -= 1n;
  }
  return base;
}

/** Per-token USD price string (OpenRouter /models format) from pico-per-token. */
export const priceString = (picoPerToken: Pico | null | undefined) =>
  picoPerToken == null ? "0" : picoToUsdString(picoPerToken);
