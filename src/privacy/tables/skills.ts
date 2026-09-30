import type { TableDoc } from "../types.ts";
import { CREATED, JSON_FIELDS, KEPT, UPDATED, rv } from "./common.ts";

// The Secured Skills Hub: published agent skills with their scan reports, and installs of them.

export const skillTables: Record<string, TableDoc> = {
  skills: {
    category: "operations",
    purpose:
      "Agent skills published to the Skills Hub: the manifest from SKILL.md, the files as one canonical tar, its SHA-256, where it came from and the static scan report. A skill is public content its author chose to publish; it is not a request.",
    request: "no",
    retention: "Kept while the hub lists the skill. A revoked skill stays, marked revoked, so its report and hash remain checkable.",
    columns: {
      id: "Skill id: sk_ followed by the first 24 hex characters of content_hash.",
      name: "The skill's name from SKILL.md, up to 64 characters.",
      slug: "The name in lowercase letters, digits and hyphens.",
      version: "The version from SKILL.md, up to 32 characters.",
      description: {
        purpose: "The description from SKILL.md, up to 1,024 characters.",
        review: rv(["name:content"], "config", "Written by the skill's author in the SKILL.md frontmatter of a skill they publish; shown in the public registry. It is not a request to a model."),
      },
      author: "The author named in SKILL.md, up to 80 characters.",
      account_id: "The publishing account, credited the author share of paid installs; empty for a mirrored skill.",
      created_by: "The key hash that imported the skill; empty for the mirror job.",
      source: {
        purpose: "Where the skill came from: upload, git (repository URL, ref, commit, folder) or mirror (the registry index).",
        review: rv(["type:json"], "public-reference", "The public repository URL, ref, commit and folder the importer named, or the registry index the operator configured in SKILLS_SOURCES. It identifies public code, not a caller."),
      },
      files: {
        purpose: "The skill's files: path, type, mode, size and SHA-256 of each, in canonical order.",
        review: JSON_FIELDS("Paths, sizes, modes and hashes computed from the published archive."),
      },
      tar_sha256: "The content hash: SHA-256 of the canonical tar of the files, which a client checks after download and the key on chain (SkillRegistry).",
      archive: "The files as a gzipped canonical tar (base64), capped at SKILLS_MAX_BYTES unpacked. It is the published skill, served by the download route.",
      size: "Unpacked bytes.",
      file_count: "Number of files.",
      level: "The scan level: trusted, caution or dangerous.",
      score: "The scan score, 0 to 100.",
      report: {
        purpose: "The scan report: scanner version, score, level, counts per severity and each finding (rule, file, line, a 160-character excerpt of the skill's own file, severity).",
        review: rv(["type:json"], "public-reference", "Computed by the scanner from the published skill's files; the excerpts are lines of those files. Nothing from any request is written here."),
      },
      price_usdg: "Install price in USDG base units (6 decimals); 0 for a free skill.",
      revoked_at: "When the operator revoked the skill.",
      revoked_reason: "The operator's reason for revoking it, up to 280 characters.",
      created_at: CREATED,
      updated_at: UPDATED,
    },
  },

  skill_installs: {
    category: "billing",
    purpose: "One row per (skill, installing account): the price paid, the author's share, the network fee and the signed install receipt. The ledger rows of a paid install use refs derived from the same pair, which makes an install idempotent.",
    request: "no",
    retention: KEPT,
    columns: {
      id: "Install id (si_...).",
      skill_id: "The skill installed.",
      account_id: "The installing account.",
      key_hash: "The key that installed it.",
      price_usdg: "The price paid in USDG base units; 0 for a free skill or the author's own.",
      author_share: "Pico-USD credited to the author's account (the price less SKILLS_FEE_BPS).",
      fee: "Pico-USD credited to the network fee account.",
      receipt: {
        purpose: "The install receipt: skill id, content hash, level, installer and author accounts, amounts and time, with an Ed25519 signature from the receipt key.",
        review: JSON_FIELDS("Ids, hashes, amounts and a timestamp chosen by our code, plus the signature over them."),
      },
      created_at: CREATED,
    },
  },
};
