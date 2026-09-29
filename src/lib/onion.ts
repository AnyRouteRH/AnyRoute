import { createHash, timingSafeEqual } from "node:crypto";

// Reaching the router over Tor. The onion service (deploy/onion) forwards each request to the router over a private
// network, so the router sees the onion service's address instead of the client's, and Tor gives it nothing else to
// tell clients apart. The forwarding proxy therefore marks every request it forwards with a header whose value is a
// secret it shares with the router. The router treats a request as an onion request only when that value matches, so a
// client that sends the header itself, without the secret, is an ordinary client.

/** The header the onion proxy sets on every request it forwards, and strips from what clients send. */
export const ONION_HEADER = "x-anyroute-onion";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Decode unpadded lowercase base32; the input is already known to hold only its alphabet. */
function base32(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    acc = (acc << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

/**
 * A version 3 onion hostname, lowercased: 56 base32 characters and ".onion". The name encodes the service's public key,
 * a two-byte checksum and the version, so a typo is caught here rather than published.
 */
export function parseOnionAddress(raw: string): string {
  const host = raw.trim().toLowerCase();
  if (!/^[a-z2-7]{56}\.onion$/.test(host)) throw new Error("ONION_ADDRESS must be a version 3 onion hostname: 56 base32 characters followed by .onion, with no scheme or path.");
  const bytes = base32(host.slice(0, 56));
  const key = bytes.subarray(0, 32);
  const checksum = createHash("sha3-256").update(".onion checksum").update(key).update(Uint8Array.of(3)).digest().subarray(0, 2);
  if (bytes[34] !== 3 || !checksum.equals(bytes.subarray(32, 34))) throw new Error("ONION_ADDRESS is not a valid version 3 onion address (bad checksum or version). Check it for a typo.");
  return host;
}

/** ONION_PROXY_SECRET: one secret, or up to three separated by commas so the secret can be rotated without a gap. */
export function parseOnionSecrets(raw: string | undefined): string[] {
  if (!raw) return [];
  const secrets = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (secrets.length > 3) throw new Error("ONION_PROXY_SECRET may hold at most three secrets (the current one and those being rotated out).");
  for (const s of secrets) if (!/^[A-Za-z0-9._~+/=-]{32,200}$/.test(s)) throw new Error("ONION_PROXY_SECRET must be 32 to 200 characters from A-Z a-z 0-9 . _ ~ + / = - (for example `openssl rand -hex 32`).");
  if (new Set(secrets).size !== secrets.length) throw new Error("ONION_PROXY_SECRET lists the same secret twice.");
  return secrets;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** True when `header` equals one of the secrets. Compares fixed-length digests in constant time and checks every secret. */
export function matchesOnionSecret(secrets: readonly string[], header: string | null | undefined): boolean {
  if (!header || !secrets.length) return false;
  const given = digest(header);
  let ok = false;
  for (const s of secrets) if (timingSafeEqual(given, digest(s))) ok = true;
  return ok;
}
