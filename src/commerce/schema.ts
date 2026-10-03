import { bigint, boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// A working copy of public chain data: every USDG Transfer on the configured chain from COMMERCE_FUNDING_FROM_BLOCK on
// (commerce/funding.ts). The commerce ledger reads it to see which wallets funded which; it holds no account, key or
// request data. Its read cursor is the chain_cursor row "commerce-usdg".
export const commerceTransfers = pgTable(
  "commerce_transfers",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true, mode: "date" }).notNull(),
    fromAddress: text("from_address").notNull(), // lowercase 0x
    toAddress: text("to_address").notNull(), // lowercase 0x
    valueUsdg: bigint("value_usdg", { mode: "bigint" }).notNull(), // USDG base units (6 decimals)
    // Moved by an EIP-3009 authorization of from_address (an AuthorizationUsed log in the same transaction), and then
    // the transaction's sender (the relayer); null for plain transfers. Settlements are authorized transfers.
    authorized: boolean("authorized").notNull().default(false),
    txFrom: text("tx_from"),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.logIndex] }),
    index("commerce_transfers_to_idx").on(t.toAddress, t.blockTime),
    index("commerce_transfers_from_idx").on(t.fromAddress, t.blockTime),
  ],
);
