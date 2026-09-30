import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "../context.ts";
import { accounts, skillInstalls, skills } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsd, usdgToPico } from "../lib/money.ts";
import { uid } from "../lib/util.ts";
import { ensureAccount, post } from "../ledger/ledger.ts";
import type { SkillSource } from "../config.ts";
import { ArchiveError, collectFiles, contentHash, fileEntries, packSkill, readArchive, skillRoot, type Limits, type SkillFile } from "./archive.ts";
import { fetchGitTree } from "./git.ts";
import { ManifestError, readManifest, type SkillManifest } from "./manifest.ts";
import { DEFAULT_ALLOWED_HOSTS, levelCode, scanSkill, type Level, type ScanReport } from "./scanner.ts";

// The hub's service layer: normalise a skill from any source into { manifest, files, content_hash }, scan it, store it once per
// content hash, and handle installs (a paid install moves credits on the ledger: 90% to the author, 10% network fee).

export type SkillRow = typeof skills.$inferSelect;
export type Source = { kind: "upload" | "git" | "mirror"; repo?: string; ref?: string; commit?: string; path?: string; registry?: string };
export type Normalized = { manifest: SkillManifest; files: SkillFile[]; contentHash: string };

export const SKILLS_FEE_ACCOUNT = "skills_fee";

export const limitsOf = (ctx: Ctx): Limits => ({ maxBytes: ctx.cfg.skills.maxBytes, maxFiles: ctx.cfg.skills.maxFiles });
export const allowedHosts = (ctx: Ctx) => [...DEFAULT_ALLOWED_HOSTS, ...ctx.cfg.skills.extraHosts];

/** Turn archive/import errors into 400s with their message. */
async function guarded<T>(f: () => Promise<T> | T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ArchiveError) fail(400, e.message, "invalid_skill_archive");
    if (e instanceof ManifestError) fail(400, e.message, "invalid_skill_manifest");
    throw e;
  }
}

export function normalize(files: SkillFile[], subpath?: string | null): Normalized {
  const root = skillRoot(files, subpath);
  const manifest = readManifest(root);
  return { manifest, files: root, contentHash: contentHash(root) };
}

export const normalizeArchive = (ctx: Ctx, bytes: Uint8Array, subpath?: string | null) => guarded(() => normalize(readArchive(bytes, limitsOf(ctx)), subpath));

export async function normalizeGit(ctx: Ctx, repo: string, ref?: string | null, subpath?: string | null) {
  return guarded(async () => {
    const { files, commit } = await fetchGitTree({ url: repo, ref }, { ...limitsOf(ctx), allowLocal: ctx.cfg.skills.allowLocalGit, timeoutMs: ctx.cfg.skills.gitTimeoutMs });
    const n = normalize(collectFiles(skillRoot(files, subpath), limitsOf(ctx)));
    return { ...n, commit };
  });
}

/** Store a normalised skill (scan included). Idempotent per content hash: the existing row is returned with created=false. */
export async function storeSkill(ctx: Ctx, n: Normalized, o: { source: Source; accountId?: string | null; keyHash?: string | null; priceUsdg?: bigint }): Promise<{ row: SkillRow; created: boolean }> {
  const id = "sk_" + n.contentHash.slice(0, 24);
  const [existing] = await ctx.db.select().from(skills).where(eq(skills.contentHash, n.contentHash));
  if (existing) return { row: existing, created: false };
  const report = scanSkill(n.files, { allowedHosts: allowedHosts(ctx) });
  const packed = packSkill(n.files);
  const [row] = await ctx.db
    .insert(skills)
    .values({
      id,
      name: n.manifest.name,
      slug: n.manifest.slug,
      version: n.manifest.version,
      description: n.manifest.description,
      author: n.manifest.author,
      accountId: o.accountId ?? null,
      createdBy: o.keyHash ?? null,
      source: o.source,
      files: fileEntries(n.files),
      contentHash: n.contentHash,
      archive: Buffer.from(packed).toString("base64"),
      size: n.files.reduce((s, f) => s + f.data.length, 0),
      fileCount: n.files.length,
      level: report.level,
      score: report.score,
      report,
      priceUsdg: o.priceUsdg ?? 0n,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [again] = await ctx.db.select().from(skills).where(eq(skills.contentHash, n.contentHash));
    return { row: again!, created: false };
  }
  return { row, created: true };
}

const usdgToUsd = (u: bigint) => picoToUsd(usdgToPico(u));

export function summaryJson(r: SkillRow) {
  const report = r.report as ScanReport;
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    version: r.version,
    description: r.description,
    author: r.author,
    content_hash: r.contentHash,
    level: r.level as Level,
    score: r.score,
    findings: report.summary,
    price_usd: usdgToUsd(r.priceUsdg),
    files: r.fileCount,
    size: r.size,
    source: (r.source as Source).kind,
    revoked: !!r.revokedAt,
    created_at: r.createdAt.toISOString(),
  };
}

export function detailJson(ctx: Ctx, r: SkillRow) {
  const src = r.source as Source;
  return {
    ...summaryJson(r),
    manifest: { name: r.name, version: r.version, description: r.description, author: r.author },
    files: r.files,
    file_count: r.fileCount,
    source: src,
    scan: r.report,
    downloadable: downloadable(ctx, r),
    revoked_at: r.revokedAt?.toISOString() ?? null,
    revoked_reason: r.revokedReason,
    // What SkillRegistry.publish(skillHash, author, priceUSDG, trustLevel, uri) takes for this skill.
    chain: { skill_hash: `0x${r.contentHash}`, trust_level: levelCode(r.level as Level), price_usdg: r.priceUsdg.toString(), uri: `${(ctx.cfg.publicUrl ?? "").replace(/\/$/, "")}/api/v1/skills/${r.id}` },
  };
}

export const downloadable = (ctx: Ctx, r: SkillRow) => !r.revokedAt && ctx.cfg.skills.downloadLevels.includes(r.level as Level);

/** 403 with the scan report when a skill is revoked or its level is blocked. */
export function assertServable(ctx: Ctx, r: SkillRow) {
  if (r.revokedAt) fail(403, `This skill was revoked: ${r.revokedReason ?? "no reason given"}.`, "skill_revoked", { report: r.report, revoked_at: r.revokedAt.toISOString() });
  if (!downloadable(ctx, r))
    fail(403, `This skill scanned as ${r.level} and is blocked from download and install. The scan report lists why.`, "skill_blocked", { level: r.level, score: r.score, report: r.report });
}

export type InstallResult = { install: typeof skillInstalls.$inferSelect; created: boolean };

/**
 * Install a skill for an account. Free skills (and the author's own) record the install with a zero price. A paid install
 * debits the installer the price, credits the author's account the price minus SKILLS_FEE_BPS and the network fee account the
 * rest, in one transaction with ledger refs unique per (skill, installer): a repeat returns the first install and its receipt.
 */
export async function installSkill(ctx: Ctx, r: SkillRow, installer: { accountId: string; keyHash: string | null }): Promise<InstallResult> {
  const [prior] = await ctx.db.select().from(skillInstalls).where(and(eq(skillInstalls.skillId, r.id), eq(skillInstalls.accountId, installer.accountId)));
  if (prior) return { install: prior, created: false };
  assertServable(ctx, r);
  const paid = r.priceUsdg > 0n && r.accountId !== null && r.accountId !== installer.accountId;
  const price = paid ? usdgToPico(r.priceUsdg) : 0n;
  const fee = (price * BigInt(ctx.cfg.skills.feeBps)) / 10_000n;
  const authorShare = price - fee;
  const id = uid("si_");
  const createdAt = new Date();
  const payload = {
    type: "anyroute.skill_install/v1",
    install_id: id,
    skill_id: r.id,
    content_hash: r.contentHash,
    level: r.level,
    installer: installer.accountId,
    author_account: r.accountId,
    price_usd: picoToUsd(price),
    author_usd: picoToUsd(authorShare),
    fee_usd: picoToUsd(fee),
    fee_bps: paid ? ctx.cfg.skills.feeBps : 0,
    created_at: createdAt.toISOString(),
  };
  const sig = ctx.signer.sign(payload);
  const receipt = { payload, signature: { alg: "Ed25519", key_id: sig.keyId, sig: sig.sig } };
  return ctx.db.transaction(async (tx) => {
    if (paid) {
      const [acct] = await tx.select().from(accounts).where(eq(accounts.id, installer.accountId)).for("update");
      const available = acct ? acct.balance - acct.held : 0n;
      if (available < price)
        fail(402, `Installing this skill costs $${picoToUsd(price)} and $${picoToUsd(available < 0n ? 0n : available)} is available. Deposit USDG first.`, "insufficient_credits", { required_usd: picoToUsd(price), available_usd: picoToUsd(available) });
    }
    const [row] = await tx
      .insert(skillInstalls)
      .values({ id, skillId: r.id, accountId: installer.accountId, keyHash: installer.keyHash, priceUsdg: paid ? r.priceUsdg : 0n, authorShare, fee, receipt, createdAt })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [again] = await tx.select().from(skillInstalls).where(and(eq(skillInstalls.skillId, r.id), eq(skillInstalls.accountId, installer.accountId)));
      return { install: again!, created: false };
    }
    if (paid) {
      const ref = `skill:${r.id}:${installer.accountId}`;
      await ensureAccount(tx, SKILLS_FEE_ACCOUNT, "network_fee");
      await ensureAccount(tx, r.accountId!);
      await post(tx, { accountId: installer.accountId, keyHash: installer.keyHash, amount: -price, kind: "skill_purchase", ref: `${ref}:buy`, description: `Skill ${r.slug}@${r.version} (${r.id})` });
      await post(tx, { accountId: r.accountId!, amount: authorShare, kind: "skill_sale", ref: `${ref}:author`, description: `Skill sale ${r.slug}@${r.version} (${r.id})` });
      if (fee > 0n) await post(tx, { accountId: SKILLS_FEE_ACCOUNT, amount: fee, kind: "skill_fee", ref: `${ref}:fee`, description: `Network fee on ${r.id}` });
    }
    return { install: row, created: true };
  });
}

export const installJson = (i: typeof skillInstalls.$inferSelect) => ({
  id: i.id,
  skill_id: i.skillId,
  price_usd: usdgToUsd(i.priceUsdg),
  author_usd: picoToUsd(i.authorShare),
  fee_usd: picoToUsd(i.fee),
  receipt: i.receipt,
  created_at: i.createdAt.toISOString(),
});

export async function hasInstall(ctx: Ctx, skillId: string, accountId: string) {
  const [row] = await ctx.db.select({ id: skillInstalls.id }).from(skillInstalls).where(and(eq(skillInstalls.skillId, skillId), eq(skillInstalls.accountId, accountId)));
  return !!row;
}

export async function installCount(ctx: Ctx, skillId: string) {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(skillInstalls).where(eq(skillInstalls.skillId, skillId));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// mirror job

export type MirrorDeps = {
  /** Fetch an index document or a tarball. The default is the global fetch; tests pass fixtures. */
  fetch?: (url: string) => Promise<Response>;
};
type IndexEntry = { git?: string; ref?: string; path?: string; tarball?: string; sha256?: string };

/** Every folder in a repository tree that has a SKILL.md, as its path ("" for the root). */
export function skillDirs(files: SkillFile[]) {
  return files.filter((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md")).map((f) => f.path.slice(0, -"SKILL.md".length).replace(/\/$/, "")).sort();
}

/**
 * Pull skills from SKILLS_SOURCES: a git source imports each listed path (or every folder with a SKILL.md), an index source is a
 * JSON document { skills: [{ git, ref?, path? } | { tarball, sha256? }] }. Each skill is scanned and stored like an upload,
 * with source kind "mirror" and no author account. Failures are counted per source; one bad skill does not stop the run.
 */
export async function runSkillsMirror(ctx: Ctx, deps: MirrorDeps = {}, sources: SkillSource[] = ctx.cfg.skills.sources) {
  const get = deps.fetch ?? ((url: string) => fetch(url, { redirect: "error", signal: AbortSignal.timeout(ctx.cfg.skills.gitTimeoutMs) }));
  const out = { sources: sources.length, imported: 0, existing: 0, failed: [] as { source: string; error: string }[] };
  const keep = async (n: Normalized, source: Source) => {
    const { created } = await storeSkill(ctx, n, { source });
    if (created) out.imported++;
    else out.existing++;
  };
  const fromGit = async (repo: string, ref: string | undefined, paths: string[] | undefined, registry?: string) => {
    const { files, commit } = await fetchGitTree({ url: repo, ref }, { ...limitsOf(ctx), allowLocal: ctx.cfg.skills.allowLocalGit, timeoutMs: ctx.cfg.skills.gitTimeoutMs });
    for (const dir of paths ?? skillDirs(files)) {
      try {
        const sub = collectFiles(dir ? skillRoot(files, dir) : files, limitsOf(ctx));
        await keep(normalize(sub), { kind: "mirror", repo, ref: ref ?? "HEAD", commit, ...(dir ? { path: dir } : {}), ...(registry ? { registry } : {}) });
      } catch (e) {
        out.failed.push({ source: `${repo}${dir ? `#${dir}` : ""}`, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
      }
    }
  };
  for (const s of sources) {
    try {
      if (s.kind === "git") await fromGit(s.url, s.ref, s.paths);
      else {
        const res = await get(s.url);
        if (!res.ok) throw new Error(`index returned HTTP ${res.status}`);
        const doc = (await res.json()) as { skills?: IndexEntry[] };
        for (const e of (doc.skills ?? []).slice(0, 500)) {
          try {
            if (e.git) await fromGit(e.git, e.ref, e.path !== undefined ? [e.path] : undefined, s.url);
            else if (e.tarball) {
              const r = await get(e.tarball);
              if (!r.ok) throw new Error(`tarball returned HTTP ${r.status}`);
              const bytes = new Uint8Array(await r.arrayBuffer());
              const n = normalize(readArchive(bytes, limitsOf(ctx)), e.path);
              if (e.sha256 && e.sha256.toLowerCase() !== n.contentHash) throw new Error("content hash does not match the index");
              await keep(n, { kind: "mirror", registry: s.url, repo: e.tarball });
            }
          } catch (err) {
            out.failed.push({ source: e.git ?? e.tarball ?? s.url, error: err instanceof Error ? err.message.slice(0, 200) : "failed" });
          }
        }
      }
    } catch (err) {
      out.failed.push({ source: s.url, error: err instanceof Error ? err.message.slice(0, 200) : "failed" });
    }
  }
  return out;
}
