import { z } from "zod";

// B: per-call market-data tools (src/data-tools/routes.ts). Off unless DATA_TOOLS_ENABLED. One flat price per call, in USD
// (USDG counted as one dollar): a prepaid key pays it from its balance, a caller without a key pays it with x402 (or CallPay)
// once per-call payment is configured on the router. A refusal (stale feed, paused token, unknown symbol) is never charged.
const bool = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

export const dataToolsEnv = {
  DATA_TOOLS_ENABLED: bool.default(false),
  DATA_TOOLS_PRICE_USD: z.coerce.number().positive("must be above zero").max(1, "must be at most 1 USD").default(0.001),
};

type DataToolsEnv = { DATA_TOOLS_ENABLED: boolean; DATA_TOOLS_PRICE_USD: number };
export const dataToolsSettings = (e: DataToolsEnv) => ({ enabled: e.DATA_TOOLS_ENABLED, priceUsd: e.DATA_TOOLS_PRICE_USD });
export type DataToolsSettings = ReturnType<typeof dataToolsSettings>;
