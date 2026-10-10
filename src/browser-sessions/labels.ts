import type { Tx } from "../db/client.ts";
import { kv } from "../db/schema.ts";

// E147: fixed families only; never retain the header, versions, device model or address.
export function browserLabel(header?: string) {
  const ua = (header ?? "").slice(0, 2048);
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua) ? "Edge"
    : /(?:OPR|Opera)\//i.test(ua) ? "Opera"
    : /(?:Firefox|FxiOS)\//i.test(ua) ? "Firefox"
    : /(?:Chrome|CriOS)\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari" : "Browser";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Windows/i.test(ua) ? "Windows" : /Macintosh|Mac OS X/i.test(ua) ? "macOS"
    : /CrOS/i.test(ua) ? "ChromeOS" : /Linux/i.test(ua) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}
export const browserSessionKey = (hash: string) => `browser-session:${hash}`;
export async function recordBrowserSession(tx: Tx, hash: string, header?: string) {
  await tx.insert(kv).values({ key: browserSessionKey(hash), value: { label: browserLabel(header) } });
}
