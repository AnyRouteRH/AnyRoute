import { createHash } from "node:crypto";

// Version 3 onion addresses: 56 base32 characters and ".onion". The name encodes the service's public key, a two-byte
// checksum and the version, so a typo is caught here instead of being sent to Tor as an unknown name.

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
 * The hostname of a version 3 onion address, lowercased. Accepts the bare name or an http:// URL of it (a trailing slash
 * is fine); anything else, including a path, a port or a name that fails its own checksum, is refused.
 */
export function parseOnionAddress(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/^http:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z2-7]{56}\.onion$/.test(host)) throw new Error("An onion address is 56 base32 characters followed by .onion, with no path or port.");
  const bytes = base32(host.slice(0, 56));
  const key = bytes.subarray(0, 32);
  const checksum = createHash("sha3-256").update(".onion checksum").update(key).update(Uint8Array.of(3)).digest().subarray(0, 2);
  if (bytes[34] !== 3 || !checksum.equals(bytes.subarray(32, 34))) throw new Error("That is not a valid version 3 onion address (bad checksum or version). Check it for a typo.");
  return host;
}
