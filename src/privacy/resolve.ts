import { and, desc, eq } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { attestations } from "../db/schema.ts";
import { unlinkableTransports } from "../onion/lane.ts";
import { privacyLabel, type PrivacyLabel } from "./label.ts";

/**
 * The privacy label for a stored receipt, with the two facts only the router knows: the TEE type recorded for the
 * attestation the receipt cites, and the transports this router serves lane "unlinkable" over. The label itself is
 * computed from the receipt alone (label.ts); a receipt with no payload gets a label that says nothing was recorded.
 */
export async function labelForReceipt(ctx: Ctx, receipt: { id?: string | null; payload?: unknown }): Promise<PrivacyLabel> {
  const payload = receipt.payload && typeof receipt.payload === "object" && !Array.isArray(receipt.payload) ? (receipt.payload as Record<string, unknown>) : {};
  const provider = typeof payload.provider === "string" ? payload.provider : null;
  const hash = typeof payload.attestation === "string" ? payload.attestation : null;
  let teeKind: string | null = null;
  if (provider && hash && payload.disclosure === "attested") {
    try {
      const [row] = await ctx.db
        .select({ teeKind: attestations.teeKind })
        .from(attestations)
        .where(and(eq(attestations.providerId, provider), eq(attestations.reportHash, hash)))
        .orderBy(desc(attestations.ts))
        .limit(1);
      teeKind = row?.teeKind ?? null;
    } catch {
      teeKind = null; // the label then says the receipt does not name the TEE type
    }
  }
  return privacyLabel({ id: receipt.id ?? undefined, payload }, { teeKind, unlinkableTransports: unlinkableTransports(ctx.cfg), baseUrl: ctx.cfg.publicUrl });
}
