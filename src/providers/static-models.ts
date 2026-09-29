import { eq } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { kv, providers } from "../db/schema.ts";
import { canonicalJson, sha256 } from "../lib/util.ts";
import { applicationReviewHash } from "./application.ts";

// Changing the model list of a provider that is already serving traffic. While an application is pending the list is
// part of its review hash (providers.setStaticModels). Once a provider is approved that procedure refuses, so the
// list of a shadow, live or suspended provider changes in two steps:
//
//   providers.proposeStaticModels  stores the candidate list beside the provider (it changes nothing that serves) and
//                                  returns a review hash with a diff against the list now in force
//   providers.approveStaticModels  applies the stored list only when given that hash
//
// The hash covers the provider's whole reviewed application (address, key, headers, policy, current list) and the
// proposed list, so it is refused if either changed after the review, and a newer proposal replaces the older one.

const PENDING = "static-models-pending:";
export const pendingKey = (providerId: string) => PENDING + providerId;

type Row = typeof providers.$inferSelect;
type Entry = Record<string, unknown>;

/** Digest of a model list (null: no static list, the provider's own /models is used). */
export const staticModelsDigest = (models: unknown[] | null | undefined) => sha256(canonicalJson(models ?? null));

/** What an operator approves: this provider, as reviewed, gaining exactly this list. */
export function staticModelsReviewHash(p: Row, proposed: unknown[]) {
  return sha256(canonicalJson({ v: 1, kind: "static-models", id: p.id, application: applicationReviewHash(p), proposed: staticModelsDigest(proposed) }));
}

export type PendingStaticModels = { v: 1; models: unknown[]; proposedAt: string };

export async function loadPendingStaticModels(db: Db | Tx, providerId: string): Promise<PendingStaticModels | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, pendingKey(providerId)));
  const v = row?.value as Partial<PendingStaticModels> | undefined;
  return v && v.v === 1 && Array.isArray(v.models) && typeof v.proposedAt === "string" ? (v as PendingStaticModels) : null;
}

export async function savePendingStaticModels(db: Db | Tx, providerId: string, models: unknown[], now = new Date()) {
  const value: PendingStaticModels = { v: 1, models, proposedAt: now.toISOString() };
  await db.insert(kv).values({ key: pendingKey(providerId), value }).onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } });
}

export async function clearPendingStaticModels(db: Db | Tx, providerId: string) {
  await db.delete(kv).where(eq(kv.key, pendingKey(providerId)));
}

const idOf = (m: unknown) => String((m as Entry | null)?.id ?? "");

/** How a proposed list differs from the list in force: models added, removed, and per-field changes to the rest. */
export function diffStaticModels(current: unknown[] | null, proposed: unknown[]) {
  const before = new Map((current ?? []).map((m) => [idOf(m), m as Entry]));
  const after = new Map(proposed.map((m) => [idOf(m), m as Entry]));
  const brief = (m: Entry) => ({ id: idOf(m), input_modalities: m.input_modalities ?? ["text"], output_modalities: m.output_modalities ?? ["text"], context_length: m.context_length, pricing: m.pricing });
  const added = [...after].filter(([id]) => !before.has(id)).map(([, m]) => brief(m));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed: { id: string; fields: Record<string, { from: unknown; to: unknown }> }[] = [];
  let unchanged = 0;
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (!prev) continue;
    const fields: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) if (canonicalJson(prev[k] ?? null) !== canonicalJson(next[k] ?? null)) fields[k] = { from: prev[k] ?? null, to: next[k] ?? null };
    if (Object.keys(fields).length) changed.push({ id, fields });
    else unchanged++;
  }
  return { current_models: before.size, proposed_models: after.size, added, removed, changed, unchanged };
}
