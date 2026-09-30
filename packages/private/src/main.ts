#!/usr/bin/env node
import { runCli } from "./cli.ts";

// The entry point of the single-file build (web/public/private.mjs) and of the `anyroute-private` command.
//
// The runtime's fetch is switched off before anything else runs, so no code in this program, and none in a library it
// bundles, can send a request except through the SOCKS client in socks.ts, which connects only to your Tor client. The
// one exception is `buy --clearnet`, which is handed the original fetch by name and nothing else is.
const directFetch = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = () => Promise.reject(new Error("anyroute-private never uses the clearnet: this call was refused."));

const code = await runCli(process.argv.slice(2), {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  env: process.env,
  directFetch,
});
process.exitCode = code;
// `start` returns only after it has closed its server. If a socket is still open when a command has finished, don't wait for it.
setTimeout(() => process.exit(code), 250).unref();
