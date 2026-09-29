#!/usr/bin/env bun
import { boot } from "./boot.ts";
import { loadConfig } from "./config.ts";
import { hashModelPath } from "./digest.ts";
import { startServer } from "./server.ts";
import { SidecarError, stderrLogger } from "./util.ts";
import { SIDECAR_VERSION } from "./version.ts";

const USAGE = `anyroute-sidecar ${SIDECAR_VERSION}

usage:
  main.ts serve [--config sidecar.yaml]     hash the weights, check the pins, attest, then serve
  main.ts digest <path> [--exclude glob]... print the model digest of a weights directory (add it to the allow-list)
  main.ts version
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function serve(args: string[]) {
  const cfg = loadConfig(process.env, flag(args, "--config"));
  const rt = await boot(cfg);
  const server = startServer(rt);
  stderrLogger("info", "listening", { host: cfg.server.host, port: server.port, tls: rt.tls ? "self_signed" : "off" });
  const stop = () => {
    void server.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function digest(args: string[]) {
  const path = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--exclude");
  if (!path) throw new SidecarError("USAGE", "usage: main.ts digest <path> [--exclude glob]...");
  const exclude = args.flatMap((a, i) => (a === "--exclude" && args[i + 1] ? [args[i + 1]] : []));
  const h = await hashModelPath(path, { exclude, logger: stderrLogger });
  process.stdout.write(`${h.digest}\n`);
  stderrLogger("info", "model digest", { files: h.files, bytes: h.bytes });
}

async function main() {
  const [cmd = "serve", ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve":
      return serve(args);
    case "digest":
      return digest(args);
    case "version":
    case "--version":
      process.stdout.write(`${SIDECAR_VERSION}\n`);
      return;
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

main().catch((e) => {
  if (e instanceof SidecarError) {
    process.stderr.write(`sidecar: refusing to start [${e.code}]: ${e.message}\n`);
  } else {
    process.stderr.write(`sidecar: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  }
  process.exit(1);
});
