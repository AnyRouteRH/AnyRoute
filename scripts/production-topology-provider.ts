// HTTPS OpenAI-compatible provider for the isolated production topology smoke only.
import { Hono } from "hono";
import { createMockProvider } from "../src/providers/mock.ts";

const cert = process.env.TOPOLOGY_TLS_CERT;
const key = process.env.TOPOLOGY_TLS_KEY;
if (!cert || !key) throw new Error("Topology fixture TLS files are required.");

const provider = createMockProvider({
  name: "Topology Fixture",
  models: [{
    id: "fixture-chat",
    slug: "anyroute/topology-fixture",
    prompt: "0.0000001",
    completion: "0.0000002",
    ctx: 8192,
    quant: "fixture",
  }],
});
provider.app.get("/health", (c) => c.json({ ok: true }));
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));
app.route("/v1", provider.app);

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: 9443,
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  fetch: app.fetch,
});

console.log(`Topology mock provider listening on ${server.port}.`);
