import { desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Ctx } from "../context.ts";
import type { Db } from "../db/client.ts";
import { TransparencyLog } from "../tlog/log.ts";
import { hostPolicyEntry } from "../tlog/entries.ts";
import { hostPolicies } from "./schema.ts";
import { hostPolicySchema, policyHash, policyJson, type HostPolicy } from "./policy.ts";

export function publicPolicy(row: typeof hostPolicies.$inferSelect) {
  return { policy: JSON.parse(row.canonical) as HostPolicy, canonical: row.canonical, sha256: row.sha256,
    signature: { alg: "Ed25519", value: row.signature, verifier_key: row.verifierKey },
    transparency_log: { kind: "host_policy", proof_url: `/api/v1/tlog/proof?kind=host_policy&sha256=${row.sha256}` } };
}

/** The policy row, leaf and signed checkpoint commit together; no unsigned or unlogged version becomes current. */
export async function publishHostPolicy(ctx: Ctx, input: HostPolicy) {
  if (!ctx.cfg.networkPolicyEnabled || !ctx.tlog) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Network host policy publication is disabled." });
  const policy = hostPolicySchema.parse(input);
  const canonical = policyJson(policy);
  const sha256 = policyHash(policy);
  const issuedAt = new Date(policy.issued_at);
  if (issuedAt.getTime() > Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "Policy issue time cannot be in the future." });
  const row = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('anyroute:network:policy', 0))`);
    const [existing] = await tx.select().from(hostPolicies).where(eq(hostPolicies.version, policy.version));
    if (existing) {
      if (existing.sha256 !== sha256) throw new TRPCError({ code: "CONFLICT", message: "This policy version is already published with different contents." });
      return existing;
    }
    const [latest] = await tx.select().from(hostPolicies).orderBy(desc(hostPolicies.version)).limit(1);
    if (policy.version !== (latest?.version ?? 0) + 1) throw new TRPCError({ code: "CONFLICT", message: "Publish the next consecutive policy version, starting at 1." });
    if (latest && issuedAt < latest.issuedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Policy issue time cannot precede the previous version." });
    // This instance does not start jobs or listeners and signs with the same configured log key.
    const log = new TransparencyLog(tx as unknown as Db, ctx.cfg.tlog);
    const signature = log.signer.sign(Buffer.from(canonical)).toString("base64");
    const [saved] = await tx.insert(hostPolicies).values({ version: policy.version, issuedAt, canonical, sha256, signature, verifierKey: log.verifierKey }).returning();
    await log.append([hostPolicyEntry(policy.version, sha256)]);
    return saved;
  });
  return publicPolicy(row);
}
