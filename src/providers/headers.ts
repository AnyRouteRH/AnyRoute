import { decrypt, encrypt } from "../lib/util.ts";

export function sealProviderHeaders(secret: string, headers: Record<string, string> | undefined | null) {
  return headers && Object.keys(headers).length ? { encrypted_v1: encrypt(secret, JSON.stringify(headers)) } : null;
}
export function openProviderHeaders(secret: string, value: unknown): Record<string, string> {
  if (!value) return {};
  const record = value as Record<string, string>;
  if (typeof record.encrypted_v1 === "string") return JSON.parse(decrypt(secret, record.encrypted_v1));
  // Existing installations migrate through scripts/encrypt-provider-headers.ts before release.
  throw new Error("Legacy plaintext provider headers require migration before use.");
}
