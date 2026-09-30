import type { ExternalDoc } from "./types.ts";

export const networkJoinStores: ExternalDoc["otherStores"] = [{
  id: "network-join-operator",
  name: "Host registration on the operator’s computer",
  purpose: "The join command reads a dedicated operator wallet key from the explicitly selected file or environment variable and signs the router’s existing wallet-auth message. It submits host name, sidecar endpoint, payout address, model ids and optional contact to the selected router. Status polling sends a provider id without a wallet key. It sends no inference text and no transactions.",
  holds: "The operator’s existing key file or environment variable is left in place. The command reads the key and signup fields in process memory; only the wallet address, timestamp and signature leave as authentication. The command writes no key or signup file, logs no key and redacts key-shaped output. File read buffers are cleared, but JavaScript strings and signing-library memory cannot be reliably erased. Signup details and resulting status are printed to the operator’s terminal; the operator controls terminal retention. The router still reads inference request text in memory on every lane.",
  ttl: "Process memory lasts until the command exits. The key source and terminal history remain under the operator’s control. Router storage for host admission is described by the admission endpoint’s inventory when available.",
  requestText: "none",
  evidence: [
    { file: "scripts/network-join.ts", contains: "bytes.fill(0)" },
    { file: "scripts/network-join.ts", contains: "X-Wallet-Auth" },
    { file: "scripts/network-join.ts", contains: "if (o[\"--dry-run\"]) { out(body); return 0; }" },
    { file: "scripts/network-join.ts", contains: "export const safeOutput" },
  ],
}];
