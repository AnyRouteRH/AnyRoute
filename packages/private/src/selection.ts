import { usdToPico } from "../../../src/lib/money.ts";
import type { StoredToken } from "./store.ts";

/** Minimum face value covering the estimate, then fewest tokens. Exact bounded subset search, without floats. */
export function selectTokens(tokens: StoredToken[], budget: bigint, cap: number): StoredToken[] | null {
  const groups = new Map<bigint, StoredToken[]>();
  for (const token of tokens) {
    const value = usdToPico(token.value_usd, "floor");
    if (value <= 0n) throw new Error("Token face values must be positive.");
    const group = groups.get(value) ?? [];
    group.push(token);
    groups.set(value, group);
  }
  let states = new Map<bigint, StoredToken[]>([[0n, []]]);
  let best: { value: bigint; tokens: StoredToken[] } | null = null;
  for (const [value, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const next = new Map(states);
    for (const [sum, chosen] of states) {
      for (let n = 1; n <= Math.min(group.length, cap - chosen.length); n++) {
        const total = sum + value * BigInt(n);
        const picked = [...chosen, ...group.slice(0, n)];
        if (total >= budget) {
          if (!best || total < best.value || (total === best.value && picked.length < best.tokens.length)) best = { value: total, tokens: picked };
          break;
        }
        const old = next.get(total);
        if (!old || picked.length < old.length) next.set(total, picked);
      }
    }
    // Differently priced issuer epochs can grow the exact search. Refuse before leasing rather than approximate.
    if (next.size > 200_000) throw new Error("Too many distinct token values to select a set. Use tokens from fewer issuer epochs.");
    states = next;
  }
  return best?.tokens ?? null;
}
