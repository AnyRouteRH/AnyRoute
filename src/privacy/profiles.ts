import type { ExternalDoc } from "./types.ts";
export const profileBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/agent-profiles.ts", carries: "settings", reads: "Owner-written public profile fields (including an optional HTTPS agent endpoint), explicit rulebook category selections and bounded certificate claim identifiers.",
  then: "Authenticates the owner or authorised account administrator, checks key ownership, validates selected record claims, and publishes the card at an independent random slug. Public reads project only opted fields and verify certificate signatures and expiry.",
  kept: "Public settings, latest selected certificate and a private key-hash association in agent_profiles until unpublish. No new address reader, Redis family or log fields. Existing receipt signing key entries are published when certificates are requested.",
  evidence: [{ file: "src/api/agent-profiles.ts", contains: "profileBody.parse(await readJson(c))" }],
};
