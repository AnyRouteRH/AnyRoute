import type { AttestationProvider } from "../attestation/types.ts";
import { generateTlsKey, createTlsIdentity } from "../tls.ts";
import { AGENT_SIDECAR_VERSION, agentReportData, hash, type AgentBindings } from "./bindings.ts";
import { deriveSealingKey, openCredential, readCredential } from "./credential-store.ts";
export type AgentConfig = { imageDigest: string; keyHash: string; socket: string; credentialFile: string; routerOrigin: string; hostname: string };
export function agentConfig(env: Record<string, string | undefined>): AgentConfig {
  const imageDigest = env.AGENT_IMAGE_DIGEST ?? "", keyHash = env.AGENT_KEY_HASH ?? "";
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest) || !/^[0-9a-f]{64}$/.test(keyHash)) throw new Error("Pinned agent image digest and key fingerprint are required.");
  const router = new URL(env.AGENT_ROUTER_ORIGIN ?? "https://anyroute.tech");
  if (router.protocol !== "https:" || router.username || router.password || router.pathname !== "/" || router.search || router.hash) throw new Error("Router must be an HTTPS origin.");
  const hostname = env.AGENT_ATTEST_HOSTNAME ?? "";
  if (!hostname || /[\s/:]/.test(hostname)) throw new Error("Attestation hostname is required.");
  return { imageDigest, keyHash, socket: "/var/run/dstack.sock", credentialFile: "/sealed/api-credential.bin", routerOrigin: router.origin, hostname };
}
export async function bootAgent(config: AgentConfig, provider: AttestationProvider, load = async (compose: string) => {
  const key = await deriveSealingKey(config.socket, compose);
  try { return openCredential(key, compose, await readCredential(config.credentialFile), config.keyHash); }
  finally { key.fill(0); }
}) {
  if (provider.kind !== "dstack") throw new Error("dstack hardware attestation is required.");
  const compose = (await provider.platformInfo()).composeHash;
  if (!compose || !/^sha256:[0-9a-f]{64}$/.test(compose)) throw new Error("Measured compose hash is required.");
  const credential = await load(compose);
  if (hash(credential) !== config.keyHash) throw new Error("Credential fingerprint mismatch.");
  const tlsKey = generateTlsKey();
  const bindings: AgentBindings = { type: "anyroute.sealed-agent/1", agent_image_digest: config.imageDigest, compose_hash: compose, agent_key_hash: config.keyHash, sidecar_version: AGENT_SIDECAR_VERSION, tls_spki_sha256: hash(tlsKey.spkiDer) };
  const attest = async (nonce: string) => {
    const evidence = await provider.quote(agentReportData(bindings, nonce));
    if (evidence.dev || evidence.kind !== "dstack") throw new Error("Hardware quote required.");
    return { type: "anyroute.sealed-agent.attestation/1", bindings, evidence };
  };
  const boot = await attest("0".repeat(64));
  const tls = createTlsIdentity(tlsKey.privateKey, { attestationRef: hash(Buffer.from(boot.evidence.quote, "hex")), hostnames: [config.hostname] });
  return { bindings, attest, tls, credential };
}
// Keep agent authorization out of the container. Only fixed AnyRoute API paths reach the configured TLS origin.
export function proxyAgent(credential: string, origin: string, fetchImpl: typeof fetch = fetch) {
  const paths = new Map([["/v1/e2ee/chat/completions", ["POST"]], ["/v1/chat/completions", ["POST"]], ["/v1/embeddings", ["POST"]], ["/v1/models", ["GET"]], ["/v1/agents/me", ["GET"]], ["/v1/agents/check", ["POST"]]]);
  return async (req: Request) => {
    const url = new URL(req.url);
    if (!paths.get(url.pathname)?.includes(req.method) || url.search) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    // Preserve lane/encrypted-chat/approval inputs, never caller credentials, cookies or arbitrary hop headers.
    for (const name of ["content-type", "accept", "x-anyroute-lane", "x-anyroute-lane-downgrade", "x-anyroute-disclosure-max", "x-agent-approval", "x-e2ee-version", "x-client-pub-key", "x-model-pub-key", "x-e2ee-nonce", "x-e2ee-timestamp"]) {
      const value = req.headers.get(name); if (value) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${credential}`);
    try {
      const res = await fetchImpl(origin + "/api" + url.pathname, { method: req.method, headers, body: req.method === "POST" ? req.body : undefined, redirect: "error", signal: req.signal });
      // Includes receipt, lane, policy-hash and streaming headers as returned by the router.
      return new Response(res.body, { status: res.status, headers: res.headers });
    } catch { return new Response("Router unavailable", { status: 502 }); }
  };
}
