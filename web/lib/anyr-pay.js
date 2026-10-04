// Pure helpers for the "Pay with $ANYR" flow (components/PayAnyr.jsx): amounts, the ERC-20 transfer the user's
// wallet signs, the rate the router credits at, and where a deposit is on its way to a credit. Nothing here holds a
// key or sends anything: the wallet signs its own transfer.

export const ANYR_ATTESTED_LINE =
  'Credits pay for every model, including the attested lane: add "provider": {"lane": "attested"} to a request and the router sends it only to providers whose hardware attestation it has verified, or refuses it. The signed receipt records the lane that answered.';

export const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/** Decimal token amount -> raw base units, exactly (no floats). Throws a message fit for the user. */
export function toRawAmount(text, decimals) {
  const s = String(text ?? "").trim();
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) throw new Error("Enter an amount as a number, for example 1000.");
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Raw base units -> a decimal string with at most `maxFraction` decimals, trailing zeros trimmed, thousands grouped. */
export function formatUnits(raw, decimals, maxFraction = 4) {
  const value = BigInt(raw ?? 0);
  const unit = 10n ** BigInt(decimals);
  const whole = (value / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (value % unit).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** ERC-20 transfer(to, amount) calldata, built without a library. */
export function erc20TransferData(to, raw) {
  if (!isAddress(to)) throw new Error("That is not an address.");
  const amount = BigInt(raw);
  if (amount <= 0n) throw new Error("Enter an amount above zero.");
  if (amount >= 1n << 256n) throw new Error("That amount is too large.");
  return "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + amount.toString(16).padStart(64, "0");
}

/** balanceOf(owner) calldata. */
export function erc20BalanceData(owner) {
  if (!isAddress(owner)) throw new Error("That is not an address.");
  return "0x70a08231" + owner.slice(2).toLowerCase().padStart(64, "0");
}

/** US dollars for display: cents from $1 up; below that, enough significant digits for a token that trades far under a cent. */
export function formatUsd(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "$0";
  if (Math.abs(v) >= 1) return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const digits = Math.abs(v) >= 0.01 ? 4 : Math.min(14, -Math.floor(Math.log10(Math.abs(v))) + 3); // four significant digits
  const trimmed = v.toFixed(digits).replace(/0+$/, "");
  return "$" + ((trimmed.split(".")[1] ?? "").length < 2 ? v.toFixed(2) : trimmed);
}

/** How many tokens $1 of credit costs, as a rounded whole number with grouping ("12,136"). */
export const tokensPerDollar = (creditUsdPerToken) => (creditUsdPerToken > 0 ? Math.round(1 / creditUsdPerToken).toLocaleString("en-US") : null);

/** The window in words: "30-minute". */
const windowWord = (q) => `${q?.window_minutes ?? 30}-minute`;

/**
 * What to say about the rate, from GET /api/v1/escrow/anyr/price (or null while loading).
 * state: loading | off | live | unavailable.
 */
export function rateView(q) {
  if (q === undefined || q === null) return { state: "loading", eyebrow: "Credit rate", headline: "Reading the pool price…", detail: "", rate: null };
  if (!q.enabled) return { state: "off", eyebrow: "Credit rate", headline: "The router does not take $ANYR.", detail: "", rate: null };
  if (!q.available || !(q.credit_usd_per_token > 0)) {
    const r = q.reason || {};
    return {
      state: "unavailable",
      eyebrow: "Credit rate · unavailable",
      headline: `No ${q.symbol} price right now`,
      detail: r.message || `The ${q.symbol} price source could not be read.`,
      code: r.code || "source_unreachable",
      rate: null,
      // A transfer can still be sent: it is recorded and credited at the price in effect when it clears.
      note: "A transfer sent now is recorded and credited automatically at the price in effect when it clears, up to the per-deposit limit.",
    };
  }
  const haircut = q.haircut_bps ? ` after a ${q.haircut_bps / 100}% haircut` : " with no haircut";
  return {
    state: "live",
    eyebrow: "Credit rate · live",
    headline: `1 ${q.symbol} = ${formatUsd(q.credit_usd_per_token)} in credits`,
    detail: `The lower of the pool's spot price and its ${windowWord(q)} average (a time-weighted average of the pool's swaps)${haircut}. Deposits are credited up to ${formatUsd(q.max_usd_per_deposit)} each.`,
    rate: q.credit_usd_per_token,
    perDollar: tokensPerDollar(q.credit_usd_per_token),
    spot: q.spot_usd,
    average: q.average_usd,
    swaps: q.swaps,
    windowSeconds: q.window_seconds,
    updatedAt: q.updated_at,
  };
}

/**
 * What an amount of tokens will be credited: exact raw units, the credit in dollars, and whether the per-deposit
 * limit caps it. `rate` is credit_usd_per_token; `limit` is max_usd_per_deposit (null: none).
 */
export function creditEstimate({ amountText, decimals, rate, limit }) {
  let raw;
  try {
    raw = toRawAmount(amountText, decimals);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (raw <= 0n) return { ok: false, error: "Enter an amount above zero." };
  if (!(rate > 0)) return { ok: true, raw, credit: null, capped: false, maxTokens: null };
  const value = (Number(raw) / 10 ** decimals) * rate;
  const capped = limit != null && value > limit * (1 + 1e-9);
  return { ok: true, raw, credit: capped ? limit : value, value, capped, maxTokens: limit != null ? Math.floor(limit / rate) : null };
}

// ---- where a deposit is ----

/** The four steps a deposit walks through. */
export const STEPS = ["Sent", "Final", "Priced", "Credited"];
export const TERMINAL = new Set(["credited", "orphaned", "reversed"]);

/** GET /api/v1/escrow/deposits stage, with a fallback for routers that only send `status`. */
export const stageOf = (d) => d?.stage || { pending_finality: "confirming", pending: "crediting", provisional: "provisional", credited: "credited", orphaned: "orphaned", reversed: "reversed" }[d?.status] || "confirming";

const minutes = (s) => {
  const m = Math.max(1, Math.round(Number(s) / 60));
  return `about ${m} minute${m === 1 ? "" : "s"}`;
};

/**
 * One deposit as the dashboard shows it. `escrow` is GET /api/v1/escrow (finality: head_block, credit_block,
 * expected_credit_delay_s). tone: wait | warn | ok | bad. step: how many of STEPS are done (0-4); the next one is in progress.
 */
export function depositView(d, escrow) {
  const stage = stageOf(d);
  const sym = d.symbol || "token";
  if (stage === "provisional") return { stage, tone: "wait", step: 1, label: "Credited (settling)", detail: `${formatUsd(d.credited_usd || 0)} added while this transfer settles. Any remainder waits for finality. A chain reorganisation can reverse the early credit.` };
  if (stage === "confirming") {
    let where = "";
    try {
      const behind = BigInt(d.block) - BigInt(escrow?.credit_block);
      where = behind > 0n ? ` Your transfer is in block ${d.block}; deposits are credited from finalized blocks (the finalized block is ${behind.toLocaleString("en-US")} behind).` : "";
    } catch {
      where = "";
    }
    const eta = Number(escrow?.expected_credit_delay_s) > 0 ? ` Finality usually takes ${minutes(escrow.expected_credit_delay_s)}.` : "";
    return { stage, tone: "wait", step: 1, label: "Waiting for finality", detail: `The chain has seen your ${sym} transfer but has not finalized its block yet.${where}${eta}` };
  }
  if (stage === "awaiting_price")
    return { stage, tone: "warn", step: 2, label: "Waiting for a price", detail: d.note || `Final, but ${sym} has no trustworthy price right now. It is credited automatically once it does.` };
  if (stage === "crediting") return { stage, tone: "wait", step: 3, label: "Crediting", detail: "Final and priced. It is credited on the router's next pass, within a minute or so." };
  if (stage === "credited") {
    const at = d.price_usd ? ` at ${formatUsd(d.price_usd)} per ${sym}` : "";
    return { stage, tone: "ok", step: 4, label: "Credited", detail: `${d.credited_usd != null ? formatUsd(d.credited_usd) : "Your credit"} added to your balance${at}.${d.note ? " " + d.note : ""}` };
  }
  if (stage === "reversed") return { stage, tone: "bad", step: 3, label: "Reversed", detail: d.note || "The chain no longer contains this transfer, so its credit was reversed." };
  return { stage, tone: "bad", step: 1, label: "Not credited", detail: d.note || "The chain dropped this transfer before it was final; nothing was credited." };
}

/** The deposits of one token, newest first, at most `limit` of them. */
export const depositsOf = (deposits, symbol, limit = 5) => (Array.isArray(deposits) ? deposits.filter((d) => d.symbol === symbol).slice(0, limit) : []);

/** How often to look again: quickly while a deposit is on its way, slowly otherwise. */
export const pollInterval = (deposits) => (Array.isArray(deposits) && deposits.some((d) => !TERMINAL.has(stageOf(d))) ? 5_000 : 20_000);

/** Deposits in `next` that are credited now but were not credited (or not known) in `prev`. */
export function newlyCredited(prev, next) {
  const before = new Map((prev || []).map((d) => [d.id, stageOf(d)]));
  return (next || []).filter((d) => stageOf(d) === "credited" && before.get(d.id) !== "credited");
}
