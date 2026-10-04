/** A failed poll does not erase the last successful account reading. */
export type BalanceReading = { balance_usd: number; checked_at: number };
export type BalanceSnapshot = { balance_usd: number | null; checked_at: number; status: "ok" | "unknown" | "unsupported"; last_reading?: BalanceReading };

export function latestBalance(value?: BalanceSnapshot): BalanceReading | null {
  const reading = value?.status === "ok" ? value : value?.last_reading;
  return reading && typeof reading.balance_usd === "number" && Number.isFinite(reading.balance_usd) && Number.isFinite(reading.checked_at)
    ? { balance_usd: reading.balance_usd, checked_at: reading.checked_at } : null;
}

export function parseUsdBalance(value: unknown): number | null {
  const outer = value as { data?: unknown } | null;
  const v = (outer?.data ?? value) as { balance_usd?: unknown; amount_usd?: unknown; balance?: unknown; currency?: unknown } | null;
  // A unitless balance from the configured USD account endpoint is USD. Explicit other units are refused.
  const raw = v?.balance_usd ?? v?.amount_usd ?? (v?.currency == null || v.currency === "USD" ? v?.balance : undefined);
  if (!(typeof raw === "number" || typeof raw === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()))) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function balanceState(balance: number, warn: number, critical: number, exhausted = 0) {
  return balance <= exhausted ? "exhausted" : balance < critical ? "critical" : balance < warn ? "warning" : "ok";
}
