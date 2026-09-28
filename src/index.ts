import { createApp } from "./app.ts";
import { log } from "./lib/util.ts";

const { app, ctx, close } = await createApp();

if (ctx.cfg.runtimeRole === "worker") throw new Error("Use src/worker.ts for worker-only workloads.");
const server = Bun.serve({
  hostname: ctx.cfg.host,
  port: ctx.cfg.port,
  fetch: app.fetch,
  idleTimeout: 255, // seconds; streams also send keep-alive comments every 5s
  maxRequestBodySize: 16 * 1024 * 1024,
});
log.info("anyroute listening", { url: `http://${server.hostname}:${server.port}`, db: ctx.dbKind, chain: ctx.cfg.chain.id, env: ctx.cfg.env });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  server.stop(false); // stop accepting; let in-flight requests finish
  const deadline = Date.now() + 30_000;
  while (server.pendingRequests > 0 && Date.now() < deadline) await Bun.sleep(100);
  await close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
