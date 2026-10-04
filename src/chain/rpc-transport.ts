import { fallback, http, type HttpTransportConfig, type Transport } from "viem";
import { createRpcRedactor, redactRpcError } from "./rpc-redaction.ts";

type RpcSettings = { rpcUrl: string; rpcFallbackUrls: readonly string[] };
/** Fixed primary order; no background ranking probes. Preserve single-node retry behaviour. */
export function rpcTransport(chain: RpcSettings, options: HttpTransportConfig = {}): Transport {
  const urls = [chain.rpcUrl, ...chain.rpcFallbackUrls];
  const redact = createRpcRedactor(urls);
  const safeHttp = (url: string): Transport => (args) => {
    const transport = http(url, { ...options, retryCount: urls.length > 1 ? 0 : options.retryCount })(args);
    return { ...transport, request: (async (...params) => {
      try { return await transport.request(...params); }
      catch (error) { throw redactRpcError(error, redact); }
    }) as typeof transport.request };
  };
  return urls.length === 1 ? safeHttp(urls[0]) : fallback(urls.map(safeHttp), { rank: false, retryCount: options.retryCount, retryDelay: options.retryDelay });
}
