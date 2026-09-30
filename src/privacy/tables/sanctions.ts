import type { TableDoc } from "../types.ts";
import { rv } from "./common.ts";

export const sanctionsTables: Record<string, TableDoc> = {
  sanctions_addresses: {
    category: "operations", request: "no",
    purpose: "EVM-compatible digital currency addresses extracted from the public OFAC SDN XML for provider admission and USDG payout screening. No names or identity records are stored.",
    retention: "Replaced atomically on a successful refresh; a failed refresh keeps the last good list.",
    columns: {
      address: { purpose: "Lowercase 0x-prefixed 20-byte wallet address listed by OFAC.", review: rv(["name:network"], "wallet-address", "A public digital currency wallet identifier from the SDN list, never a caller's IP or connection address.") },
      list_date: "Publication date from the SDN XML, at midnight UTC.",
      source_hash: "SHA-256 of the exact downloaded XML bytes; no XML or identity text is retained.",
    },
  },
  sanctions_meta: {
    category: "operations", request: "no",
    purpose: "Singleton metadata for the current sanctions list, exposed by GET /api/v1/network/sanctions.",
    retention: "Replaced with the address list on a successful refresh; retained on failure.",
    columns: {
      id: "Singleton identifier, always 1.",
      list_date: "Publication date from the SDN XML, at midnight UTC; this date determines freshness.",
      source_hash: "SHA-256 of the downloaded XML bytes.",
      entry_count: "Number of distinct EVM-compatible wallet addresses stored.",
      ignored_count: "Number of digital currency entries whose identifier is not an EVM-compatible 0x address.",
      refreshed_at: "When the successful download was stored, in UTC; does not reset the publication date's age.",
    },
  },
};
