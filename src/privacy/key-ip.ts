// E148
import type { Touchpoint } from './types.ts';
export const keyIpReader: Touchpoint = {
  file: 'src/key-ip/allowlist.ts',
  reads: 'The existing trusted client-IP helper for API keys with owner-set IP restrictions and for the authenticated current-IP helper. Both Bearer and x-api-key credentials are checked. No address is read on onion or Oblivious HTTP ingress.',
  then: 'In-process adapters retain the verified originating address for the same key in asynchronous request-scoped memory, rechecking its current allowlist at every hop. Compares IPv4, IPv6 and CIDR ranges in request memory and refuses a mismatch before routing or charging. The current-IP endpoint echoes the selected address once with Cache-Control: no-store. Unknown addresses fail closed. Scheduled and batch inference has no verifiable originating client IP and is refused for restricted keys.',
  kept: 'The observed caller address is never stored or logged by this feature. Only the owner-supplied allowlist is retained in keys.allowed_ips under existing key retention. The browser editor holds entered addresses and a requested current-IP response in component memory until the dialog closes; saving stores the selected list as owner settings. Existing ingress limiter retention remains unchanged. No new Redis key family or log field.',
  evidence: [{ file: 'src/key-ip/allowlist.ts', contains: 'origins.getStore()?.get(key.keyHash) ?? clientIp(c, ctx.cfg.trustProxy)' }, { file: 'src/key-ip/allowlist.ts', contains: "c.header('Cache-Control', 'no-store')" }],
};
