import { DstackAttestationProvider } from "../attestation/dstack.ts";
import { agentConfig, bootAgent, proxyAgent } from "./runtime.ts";
import { deriveSealingKey, persistCredential, sealCredential } from "./credential-store.ts";
import { hash } from "./bindings.ts";
async function main() {
  const cfg = agentConfig(process.env), provider = new DstackAttestationProvider({ endpoint: cfg.socket });
  if (process.argv[2] === "provision") {
    const compose = (await provider.platformInfo()).composeHash;
    if (!compose) throw new Error("Measured compose required.");
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = Bun.stdin.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 513) { value.fill(0); await reader.cancel(); throw new Error("Invalid credential."); }
        chunks.push(value);
      }
    } catch (e) { for (const chunk of chunks) chunk.fill(0); throw e; }
    const input = Buffer.concat(chunks);
    for (const chunk of chunks) chunk.fill(0);
    try {
      if (input.length > 513) throw new Error("Invalid credential.");
      const secret = Buffer.from(input).toString("utf8").trim();
      if (hash(secret) !== cfg.keyHash) throw new Error("Fingerprint mismatch.");
      const key = await deriveSealingKey(cfg.socket, compose);
      try { await persistCredential(cfg.credentialFile, sealCredential(key, compose, secret)); } finally { key.fill(0); }
    } finally { input.fill(0); }
    return;
  }
  if (process.argv[2] !== "serve") throw new Error("Use serve or provision.");
  const rt = await bootAgent(cfg, provider);
  Bun.serve({ hostname: "0.0.0.0", port: 8443, tls: { key: rt.tls.keyPem, cert: rt.tls.certPem }, async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/attest") return new Response("Not found", { status: 404 });
    try { return Response.json(await rt.attest(url.searchParams.get("nonce") ?? ""), { headers: { "cache-control": "no-store" } }); }
    catch { return new Response("Evidence unavailable", { status: 400 }); }
  } });
  Bun.serve({ hostname: "0.0.0.0", port: 8788, fetch: proxyAgent(rt.credential, cfg.routerOrigin) });
}
if (import.meta.main) main().catch(() => { process.stderr.write("Sealed agent startup failed. Check measurements and provisioning.\n"); process.exitCode = 1; });
