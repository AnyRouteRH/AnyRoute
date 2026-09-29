import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { providers } from "../db/schema.ts";
import { decrypt, encrypt } from "../lib/util.ts";

// Custom provider headers usually carry credentials, so they are stored only as
// `{ encrypted_v1: <AES-GCM ciphertext under APP_SECRET> }`. Runtime refuses anything else;
// the migration job (scripts/migrate.ts) converts legacy plaintext rows before a release starts.
// This module is part of the migrate image (deploy/railway/migrate.Dockerfile): keep its imports
// to src/db and src/lib/util.ts.

type SealedHeaders = { encrypted_v1: string };

export function sealProviderHeaders(secret: string, headers: Record<string, string> | undefined | null): SealedHeaders | null {
  return headers && Object.keys(headers).length ? { encrypted_v1: encrypt(secret, JSON.stringify(headers)) } : null;
}

/** The only stored shape runtime accepts: exactly one `encrypted_v1` ciphertext, nothing beside it. */
export function isSealedProviderHeaders(value: unknown): value is SealedHeaders {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as SealedHeaders).encrypted_v1 === "string";
}

export function openProviderHeaders(secret: string, value: unknown): Record<string, string> {
  if (value == null) return {};
  if (isSealedProviderHeaders(value)) return JSON.parse(decrypt(secret, value.encrypted_v1));
  throw new Error("Provider headers are not encrypted; run the migration job (scripts/migrate.ts) with APP_SECRET.");
}

// A legacy plaintext map: string values only. A ciphertext mixed with plaintext keys is not one.
const isHeaderMap = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "encrypted_v1") && Object.values(value).every((v) => typeof v === "string");

/**
 * Mandatory deployment phase, run by scripts/migrate.ts after the schema migrations. Idempotent:
 * - no legacy rows: nothing to do, and APP_SECRET is not needed;
 * - legacy plaintext rows: encrypts them under `secret` (the runtime APP_SECRET, checked against an
 *   existing ciphertext when there is one) and re-checks inside the same transaction;
 * - legacy rows but no usable secret, or values that are not a header map: throws, changing nothing.
 * Errors and results name provider ids and counts only, never header names or values.
 */
export async function enforceEncryptedProviderHeaders(db: Db, secret: string | undefined): Promise<{ checked: number; converted: string[]; remaining: number }> {
  return db.transaction(async (tx) => {
    const read = () => tx.select({ id: providers.id, headers: providers.headers, apiKeyEnc: providers.apiKeyEnc }).from(providers).orderBy(providers.id).for("update");
    const rows = await read();
    const legacy = rows.filter((r) => r.headers != null && !isSealedProviderHeaders(r.headers));
    if (!legacy.length) return { checked: rows.length, converted: [], remaining: 0 };

    const malformed = legacy.filter((r) => !isHeaderMap(r.headers)).map((r) => r.id);
    if (malformed.length)
      throw new Error(`Provider headers for ${malformed.length} provider(s) are neither encrypted nor a plain header map; correct them by hand, then rerun the migration job: ${malformed.join(", ")}.`);
    const plaintext = legacy.filter((r) => Object.keys(r.headers as object).length).map((r) => r.id);
    if (plaintext.length && (!secret || secret.length < 32))
      throw new Error(
        `${plaintext.length} provider(s) still store plaintext headers: ${plaintext.join(", ")}. ` +
          "Rerun the migration job with APP_SECRET set to the runtime secret (>= 32 chars) to encrypt them, then rotate those credentials.",
      );
    if (plaintext.length) {
      // A different secret would leave rows the runtime cannot open: prove it on an existing ciphertext.
      const probe = rows.map((r) => (isSealedProviderHeaders(r.headers) ? r.headers.encrypted_v1 : r.apiKeyEnc)).find((c): c is string => !!c);
      if (probe) {
        try {
          decrypt(secret!, probe);
        } catch {
          throw new Error("APP_SECRET does not decrypt the existing provider credentials; supply the runtime APP_SECRET.");
        }
      }
    }
    for (const r of legacy) await tx.update(providers).set({ headers: sealProviderHeaders(secret ?? "", r.headers as Record<string, string>), updatedAt: new Date() }).where(eq(providers.id, r.id));

    const remaining = (await read()).filter((r) => r.headers != null && !isSealedProviderHeaders(r.headers)).map((r) => r.id);
    if (remaining.length) throw new Error(`Provider headers remain unencrypted for ${remaining.length} provider(s): ${remaining.join(", ")}.`);
    return { checked: rows.length, converted: legacy.map((r) => r.id), remaining: 0 };
  });
}
