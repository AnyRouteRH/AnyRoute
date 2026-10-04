import { picoToUsdString } from "../lib/money.ts";
import type { ApprovalRow } from "../agents/approvals.ts";
export function guardApprovalText(row: ApprovalRow, name?: string, policySha256 = "") {
  const i = row.intent as { kind?: string; action?: string; target?: string; amount_pico?: string; details_sha256?: string };
  if (i.kind !== "action") return undefined;
  const usd = picoToUsdString(BigInt(i.amount_pico ?? row.maxCostPico));
  const [whole, fraction = ""] = usd.split(".");
  const amount = `${whole}.${fraction.padEnd(2, "0")}`;
  const hash = i.details_sha256 ? `${i.details_sha256.slice(0, 15)}…${i.details_sha256.slice(-5)}` : undefined;
  return [`AnyRoute: your agent asks first`, `Agent: ${name || row.keyHash.slice(0, 8)}`, `Action: ${i.action}`, ...(i.target === undefined ? [] : [`Target: ${i.target}`]), `Amount: $${amount}`, ...(hash ? [`Order hash: ${hash}`] : []), `Rulebook: ${policySha256.slice(0, 12) || "unavailable"}`, `Expires: ${row.expiresAt.toISOString().slice(11, 16)} UTC (${Math.ceil((row.expiresAt.getTime() - row.requestedAt.getTime()) / 60000)} min)`].join("\n");
}
