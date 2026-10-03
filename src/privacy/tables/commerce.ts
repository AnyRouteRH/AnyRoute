import type { TableDoc } from "../types.ts";
import { rv } from "./common.ts";

// v6 L: the commerce ledger's copy of public USDG transfers (src/commerce/funding.ts).
const wallet = (purpose: string) => ({ purpose, review: rv(["name:network"], "wallet-address", "A lowercase blockchain wallet or contract address copied from a public USDG Transfer log; not a caller's network address.") });

export const commerceTables: Record<string, TableDoc> = {
  commerce_transfers: {
    category: "chain",
    purpose: "When COMMERCE_STATS_ENABLED and COMMERCE_FUNDING_FROM_BLOCK are set, every USDG Transfer on the configured chain from that block on, so the commerce ledger can tell which wallets funded which. Public chain data only; no account, key, receipt or request is linked to a row.",
    request: "no",
    retention: "No automatic deletion: the funding filter reads the whole copy from the start block. Removed only when the operator drops the table or clears the copy.",
    columns: {
      tx_hash: "The public transaction hash.",
      log_index: "The log's position in the transaction.",
      block_number: "The block.",
      block_time: "The block's time.",
      from_address: wallet("The wallet the USDG left."),
      to_address: wallet("The wallet the USDG went to."),
      value_usdg: "The amount in USDG base units, capped at the bigint maximum.",
      authorized: "Whether an EIP-3009 authorization of the sender moved it (an AuthorizationUsed log by the sender in the same transaction).",
      tx_from: "For an authorized transfer, the public address that sent the transaction (the relayer); null otherwise.",
    },
  },
};
