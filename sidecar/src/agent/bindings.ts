import { createHash } from "node:crypto";
import { canonicalJson } from "../util.ts";
export const AGENT_SIDECAR_VERSION = "anyroute.agent-sidecar/1";
export type AgentBindings = {
  type: "anyroute.sealed-agent/1"; agent_image_digest: string; compose_hash: string;
  agent_key_hash: string; sidecar_version: typeof AGENT_SIDECAR_VERSION; tls_spki_sha256: string;
};
export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function agentReportData(bindings: AgentBindings, nonce: string) {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("Nonce must be 32 bytes of lowercase hex.");
  return Buffer.from(hash(canonicalJson(bindings)) + nonce, "hex");
}
