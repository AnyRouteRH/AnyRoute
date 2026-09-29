import { createHandler } from "./app.ts";
import type { Runtime } from "./boot.ts";

/** Listen with the booted runtime: HTTPS with the in-memory certificate, or plain HTTP when server.tls is "off". */
export function startServer(rt: Runtime) {
  const { cfg } = rt;
  return Bun.serve({
    hostname: cfg.server.host,
    port: cfg.server.port,
    maxRequestBodySize: cfg.upstream.maxRequestBytes + 1024,
    idleTimeout: 255,
    ...(rt.tls ? { tls: { key: rt.tls.keyPem, cert: rt.tls.certPem } } : {}),
    fetch: createHandler(rt),
  });
}
