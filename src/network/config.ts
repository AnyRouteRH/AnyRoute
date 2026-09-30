import { z } from "zod";
import { isSanctionsHost } from "./sanctions-download.ts";

export const DEFAULT_SANCTIONS_LIST_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
export const sanctionsEnv = {
  SANCTIONS_SCREENING_ENABLED: z.union([z.boolean(), z.string()]).transform((v) => typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())).default(false),
  SANCTIONS_LIST_URL: z.string().optional(),
  SANCTIONS_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(365).default(7),
};

export function sanctionsSettings(e: z.infer<z.ZodObject<typeof sanctionsEnv>>, production: boolean) {
  const url = new URL(e.SANCTIONS_LIST_URL || DEFAULT_SANCTIONS_LIST_URL);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && (production || url.protocol !== "http:" || url.hostname !== "localhost"))) throw new Error("SANCTIONS_LIST_URL must use HTTPS in production and contain no credentials or fragment.");
  if (production && !isSanctionsHost(url.hostname)) throw new Error("SANCTIONS_LIST_URL must use an allowed OFAC host in production.");
  return { enabled: e.SANCTIONS_SCREENING_ENABLED, listUrl: url.toString(), maxAgeDays: e.SANCTIONS_MAX_AGE_DAYS };
}
