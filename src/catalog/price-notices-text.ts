import { picoToUsdString } from "../lib/money.ts";

export type PriceSnapshot = { name: string; prompt: string; completion: string };
export type PriceChange = { model: string; title: string };
export const significantPriceChange = (before: bigint, after: bigint) =>
  before !== after && (before === 0n || (before > after ? before - after : after - before) * 100n >= before);

const rate = (pico: bigint) => {
  const value = picoToUsdString(pico * 1_000_000n);
  const [whole, fraction = ""] = value.split(".");
  return `$${whole}.${fraction.padEnd(2, "0")}`;
};
export function diffPrices(previous: Record<string, PriceSnapshot>, current: Record<string, PriceSnapshot>): PriceChange[] {
  const changes: PriceChange[] = [];
  for (const model of Object.keys(current).sort()) {
    const before = Object.hasOwn(previous, model) ? previous[model] : undefined, after = current[model];
    if (!before) continue;
    const parts: string[] = [];
    for (const [field, label] of [["prompt", "input"], ["completion", "output"]] as const) {
      const oldPrice = BigInt(before[field]), newPrice = BigInt(after[field]);
      if (significantPriceChange(oldPrice, newPrice)) parts.push(`${after.name} got ${newPrice < oldPrice ? "cheaper" : "pricier"}: ${rate(oldPrice)} → ${rate(newPrice)} per million ${label} tokens`);
    }
    if (parts.length) changes.push({ model, title: parts.join("; ") });
  }
  return changes;
}
