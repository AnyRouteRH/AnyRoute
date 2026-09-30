import type { ExternalDoc } from "./types.ts";

export const networkJoinStores: ExternalDoc["otherStores"] = [{
  id: "network-join-operator",
  name: "Host registration on the operator’s computer",
  purpose: "The join command reads a dedicated operator wallet key from the explicitly selected file or environment variable and signs the router’s existing wallet-auth message. It optionally reads the host-generated sidecar API key from an explicitly selected UTF-8 file or environment variable, trims and validates it, and checks POSIX file read permissions. It submits host name, sidecar endpoint, payout address, model ids and optional contact to the selected router. After successful signup, or in credential-only mode, it sends the sidecar API key and provider id over HTTPS to the router’s existing wallet-authenticated credential endpoint; an explicitly selected loopback router may use HTTP. Status polling sends a provider id without a wallet key. It sends no inference text and no transactions.",
  holds: "The operator’s existing wallet and sidecar key files or environment variables are left in place. The command reads the key and signup fields in process memory; the wallet address, timestamp and signature leave as authentication. The sidecar API key leaves in the credential request body and is stored in the router’s existing AES-GCM encrypted provider-key column; the router can decrypt it to call the sidecar. The command writes no key or signup file, logs no key and redacts loaded sidecar credentials (including JSON-escaped forms) and wallet-key-shaped output. Dry runs read neither key and show a redacted credential body, with the signup-assigned provider id still unknown. File read buffers are cleared, but JavaScript strings and signing-library memory cannot be reliably erased. Signup details and resulting status are printed to the operator’s terminal; the operator controls terminal retention. The router still reads inference request text in memory on every lane.",
  ttl: "Process memory lasts until the command exits. The key source and terminal history remain under the operator’s control. Router storage for host admission is described by the admission endpoint’s inventory when available.",
  requestText: "none",
  evidence: [
    { file: "scripts/network-join.ts", contains: "bytes.fill(0)" },
    { file: "scripts/network-join.ts", contains: "X-Wallet-Auth" },
    { file: "scripts/network-join.ts", contains: "if (o[\"--dry-run\"]) {" },
    { file: "scripts/network-join.ts", contains: "export const safeOutput" },
    { file: "scripts/network-join-credential.ts", contains: "info.mode & 0o044" },
    { file: "scripts/network-join-credential.ts", contains: "bytes.fill(0)" },
    { file: "scripts/network-join.ts", contains: "credential_configured !== true" },
  ],
}];
