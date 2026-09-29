#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { ConfigError, loadConfig } from "./config.ts";
import { createRelay } from "./relay.ts";
import { RELAY_VERSION } from "./version.ts";

const USAGE = `anyroute-ohttp-relay ${RELAY_VERSION}

usage:
  main.ts serve         forward message/ohttp-req to the configured gateways (see the README for the environment)
  main.ts healthcheck   exit 0 when the local /healthz answers 200 (used by the container HEALTHCHECK)
  main.ts version
`;

function serve() {
  const cfg = loadConfig(process.env);
  const { handle } = createRelay(cfg);
  const server = Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    maxRequestBodySize: cfg.maxBodyBytes + 1024,
    idleTimeout: 255, // the gateway may take a while to answer; nothing flows on this connection meanwhile
    ...(cfg.tls ? { tls: { cert: readFileSync(cfg.tls.certFile), key: readFileSync(cfg.tls.keyFile) } } : {}),
    fetch: handle,
    // No request detail is ever logged, not even on an error.
    error: () => new Response(JSON.stringify({ error: { code: 500, type: "internal", message: "Relay error." } }), { status: 500, headers: { "content-type": "application/json" } }),
  });
  // The only log line: what the relay is, never who talks to it.
  process.stderr.write(`${JSON.stringify({ msg: "listening", version: RELAY_VERSION, host: cfg.host, port: server.port, path: cfg.path, tls: !!cfg.tls, gateways: cfg.gateways.map((g) => g.name) })}\n`);
  const stop = () => {
    void server.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function healthcheck() {
  const cfg = loadConfig(process.env);
  try {
    const res = await fetch(`${cfg.tls ? "https" : "http"}://127.0.0.1:${cfg.port}/healthz`, { tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(5000) });
    process.exit(res.status === 200 ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

const [cmd = "serve"] = process.argv.slice(2);
try {
  if (cmd === "serve") serve();
  else if (cmd === "healthcheck") await healthcheck();
  else if (cmd === "version") process.stdout.write(`${RELAY_VERSION}\n`);
  else {
    process.stderr.write(USAGE);
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`${e instanceof ConfigError ? "configuration error" : "error"}: ${(e as Error).message}\n`);
  process.exit(1);
}
