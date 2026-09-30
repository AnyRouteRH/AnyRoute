import { and, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { hashMessage, recoverMessageAddress, type Hex } from "viem";
import type { Ctx } from "../context.ts";
import type { Db, Tx } from "../db/client.ts";
import { keys, teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd } from "../lib/money.ts";
import { roleAllowed, roleOf, type KeyRow, type Role } from "../api/auth.ts";

export type TeamRow = typeof teams.$inferSelect;

const erc1271 = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }], outputs: [{ type: "bytes4" }] }] as const;
export const ERC1271_MAGIC = "0x1626ba7e";

/**
 * Who signed `message` for `address`: "eoa" when the signature recovers to it, "contract" when the address holds code
 * (a Safe or another smart wallet) and its isValidSignature(hashMessage(message), signature) returns the EIP-1271 magic
 * value, null otherwise. The contract check reads the chain through the router's chain client.
 */
export async function verifyWalletMessage(ctx: Ctx, address: string, message: string, signature: Hex): Promise<"eoa" | "contract" | null> {
  const who = await recoverMessageAddress({ message, signature }).catch(() => null);
  if (who && who.toLowerCase() === address.toLowerCase()) return "eoa";
  try {
    const code = await ctx.chain.client.getCode({ address: address as Hex });
    if (!code || code === "0x") return null;
    const magic = await ctx.chain.client.readContract({ address: address as Hex, abi: erc1271, functionName: "isValidSignature", args: [hashMessage(message), signature] });
    return String(magic).toLowerCase() === ERC1271_MAGIC ? "contract" : null;
  } catch {
    return null;
  }
}

/** A team key's role in that team; a management key of the owning account is owner; anything else has none. */
export async function teamRoleOf(ctx: Ctx, key: KeyRow, team: TeamRow): Promise<Role | null> {
  if (key.accountId !== team.ownerAccount) return null;
  if (key.management) return "owner";
  if (key.teamId !== team.id) return null;
  return roleOf(ctx, key);
}

/** Every org-scoped route goes through here: the team must exist for the caller, and the caller's role must be allowed. */
export async function requireTeamRole(ctx: Ctx, key: KeyRow, teamId: string, allowed: Role[]) {
  const [team] = await ctx.db.select().from(teams).where(eq(teams.id, teamId));
  const role = team ? await teamRoleOf(ctx, key, team) : null;
  if (!team || !role) fail(404, "Team not found.", "not_found");
  if (!roleAllowed(role, allowed)) fail(403, `This key's role in the team (${role}) cannot do that.`, "forbidden");
  return { team, role };
}

// Readers are every org role except agent (API-only) and the legacy member; managers are admins and the owner.
export const ORG_READ: Role[] = ["owner", "admin", "dev", "viewer"];
export const ORG_ADMIN: Role[] = ["owner", "admin"];

const activeInTeam = (teamId: string, exclude?: string) =>
  and(eq(keys.teamId, teamId), eq(keys.disabled, false), or(isNull(keys.expiresAt), gt(keys.expiresAt, new Date())), exclude ? ne(keys.keyHash, exclude) : undefined);

/** The org budget already given out: the limits of the team's enabled, unexpired keys. */
export async function allocated(db: Db | Tx, teamId: string, exclude?: string): Promise<bigint> {
  const [r] = await db.select({ n: sql<string>`coalesce(sum(${keys.budget}), 0)` }).from(keys).where(activeInTeam(teamId, exclude));
  return BigInt(r?.n ?? 0);
}

/** Keys in the team with no limit at all: an org budget cannot be set while any exist. */
export async function unlimitedKeys(db: Db | Tx, teamId: string): Promise<string[]> {
  const rows = await db.select({ h: keys.keyHash }).from(keys).where(and(activeInTeam(teamId), isNull(keys.budget)));
  return rows.map((r) => r.h);
}

/** A key in a team with an org budget needs a limit, and every limit together must fit in the budget. */
export async function assertFitsOrgBudget(db: Db | Tx, teamId: string, limit: bigint | null, exclude?: string) {
  const [team] = await db.select({ budget: teams.budget }).from(teams).where(eq(teams.id, teamId));
  if (team?.budget == null) return;
  if (limit == null) fail(409, "This team has an org budget, so every key in it needs a `limit` (USD).", "org_budget_limit_required", { budget_usd: picoToUsd(team.budget) });
  const used = await allocated(db, teamId, exclude);
  if (used + limit > team.budget)
    fail(409, `That limit does not fit in the org budget: ${picoToUsd(team.budget - used > 0n ? team.budget - used : 0n)} USD of ${picoToUsd(team.budget)} USD is left.`, "org_budget_exceeded", {
      budget_usd: picoToUsd(team.budget),
      allocated_usd: picoToUsd(used),
    });
}
