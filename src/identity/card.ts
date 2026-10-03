import type { Ctx } from "../context.ts";
import type { PublicProfile } from "../agents/profile-schema.ts";
import type { TrackRecordCertificate } from "../agents/track-record-shared.ts";
import { activeFeedback, reputationOf, type FeedbackRow } from "./feedback.ts";
import { cardIdentity, identityRow, reputationUrl } from "./identity.ts";
import { latestLiveness, livenessJson } from "./liveness.ts";
import { publishedTrackRecord, trackRecordUrl } from "./track-record.ts";

/** Reputation as shown on a card and at GET /agents/:id/reputation; computed only for keys whose owner opted in. */
export async function reputationSummary(ctx: Ctx, keyHash: string, slug: string, now = new Date()): Promise<{ summary: Record<string, unknown>; rows: FeedbackRow[] }> {
  const row = await identityRow(ctx, keyHash);
  if (!row?.reputationOptIn) return { summary: { opted_in: false, url: reputationUrl(ctx, slug) }, rows: [] };
  const rows = await activeFeedback(ctx, keyHash);
  return { summary: { opted_in: true, ...reputationOf(rows, now, ctx.cfg.identity.halfLifeDays), half_life_days: ctx.cfg.identity.halfLifeDays, url: reputationUrl(ctx, slug) }, rows };
}

/** The anyroute-extension fields this feature adds to a public card; nothing while both flags are off. */
export async function cardExtras(ctx: Ctx, row: { slug: string; keyHash: string; settings: PublicProfile }) {
  const extras: Record<string, unknown> = {};
  if (ctx.cfg.identity.enabled) {
    extras.identity = await cardIdentity(ctx, row.keyHash, row.slug);
    const probe = (await latestLiveness(ctx, [{ keyHash: row.keyHash, endpoint: row.settings.endpoint }])).get(row.keyHash);
    extras.liveness = { endpoint_declared: !!row.settings.endpoint, ...livenessJson(probe) };
    const tr = await publishedTrackRecord(ctx, row.keyHash);
    const p = (tr?.certificate as TrackRecordCertificate | undefined)?.payload;
    extras.track_record = tr && p ? { id: tr.id, url: trackRecordUrl(ctx, tr.id), stats: p.stats, merkle_root: p.merkle.root, expires_at: p.expires_at } : null;
  }
  if (ctx.cfg.identity.paidFeedback) extras.reputation = (await reputationSummary(ctx, row.keyHash, row.slug)).summary;
  return extras;
}
