import { log } from "./util.ts";

// Connection failures to an upstream (a provider that stopped, a gateway that refuses) are request errors, not process
// errors. Bun's HTTP client can surface a second copy of such an error on an internal emitter that no caller can
// listen on, which would otherwise crash the process and take every job or request with it. Those, and only those,
// are logged and absorbed; the request itself still fails through its own error or timeout. Anything else still
// exits, so real bugs are never hidden.
export const NETWORK_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ECONNABORTED"]);

export function isAbsorbableNetworkError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && NETWORK_ERROR_CODES.has(code);
}

let installed = false;
export function installProcessGuard(onFatal: (e: unknown) => void = () => process.exit(1)) {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (e) => {
    if (isAbsorbableNetworkError(e)) {
      log.warn("absorbed an unhandled upstream connection error", { code: String((e as { code?: unknown }).code) });
      return;
    }
    log.error("uncaught exception", { error: e instanceof Error ? e.message : String(e) });
    onFatal(e);
  });
}
