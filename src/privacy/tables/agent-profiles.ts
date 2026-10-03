import type { TableDoc } from "../types.ts";
import { rv } from "./common.ts";
export const profileTables: Record<string, TableDoc> = {
  agent_profiles: {
    category: "keys", request: "no", purpose: "Opt-in public agent cards and an internal mapping to the owned key for updates, removal and selected live rulebook summaries.",
    retention: "Until unpublish or deletion of the key. Profile updates replace settings and certificates. Database backups and copies made by public readers can outlive deletion.",
    notes: ["Public: random slug, owner-written name, description, optional homepage, capability tags, only selected boolean rulebook categories, and selected router-issued certificates while signatures and expiry are valid. Publishing intentionally links certificate pseudonyms to this profile. The private key-hash mapping is never returned publicly; the router still knows it. Disabled or expired keys are hidden. No certificate or rulebook proves host sealing or hardware attestation, which is reported unavailable. User-written text can identify its owner. No inference prompt or answer is collected here."],
    columns: {
      slug: "Random 144-bit public identifier independent of the key hash; regenerated after unpublish and republish.",
      key_hash: "Internal unique key association for ownership checks and current opted-in policy categories; never returned in public cards.",
      settings: { purpose: "Validated public display name, short description, optional HTTP(S) homepage, optional HTTPS agent endpoint (probed daily for liveness when AGENT_IDENTITY_ENABLED is on), capability tags and selected rulebook categories.", review: rv(["type:json"], "config", "Owner-supplied publication settings deliberately become public. They contain bounded text and chosen category names, never a copied private rulebook or automatic key identifiers.") },
      certificates: { purpose: "Latest router-issued certificate for the selected key and chosen claims; replaced or cleared on each publication update.", review: rv(["type:json"], "no-request-content", "Strict signed claim identifiers, fresh pseudonym, issuance and expiry times, signing key identifier and signature. Valid certificates are public; expired or invalid certificates stay stored until update or deletion but are not returned publicly.") },
    },
  },
};
