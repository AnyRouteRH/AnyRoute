import { parse } from "yaml";
import type { SkillFile } from "./archive.ts";

// SKILL.md frontmatter, as agent skills write it (Claude-style skill folders, Hermes Agent, OpenClaw): a YAML block between
// `---` lines at the top of SKILL.md with at least `name` and `description`. Version and author may sit at the top level or
// under `metadata`. Everything else in the frontmatter is kept out of the manifest; the scanner reads the whole file anyway.

export type SkillManifest = { name: string; slug: string; version: string; description: string; author: string };

export class ManifestError extends Error {}

const clean = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

export function parseFrontmatter(text: string): Record<string, unknown> {
  const body = text.replace(/^\uFEFF/, "");
  const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!m) throw new ManifestError("SKILL.md must start with a YAML frontmatter block between --- lines.");
  let doc: unknown;
  try {
    doc = parse(m[1], { maxAliasCount: 10, prettyErrors: false });
  } catch {
    // Many hand-written skills put an unquoted ": " inside the description, which strict YAML rejects. Read top-level
    // `key: value` lines instead, splitting at the first colon, as agents that load skills do.
    const loose: Record<string, string> = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
      if (kv) loose[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    if (!loose.name) throw new ManifestError("SKILL.md frontmatter is not valid YAML.");
    doc = loose;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ManifestError("SKILL.md frontmatter must be a YAML mapping.");
  return doc as Record<string, unknown>;
}

export function readManifest(files: SkillFile[]): SkillManifest {
  const skill = files.find((f) => f.path === "SKILL.md" && f.type === "file");
  if (!skill) throw new ManifestError("No SKILL.md at the top of the skill. A skill is a folder with SKILL.md (YAML frontmatter with name and description) and its scripts and resources.");
  const fm = parseFrontmatter(new TextDecoder().decode(skill.data));
  const meta = fm.metadata && typeof fm.metadata === "object" && !Array.isArray(fm.metadata) ? (fm.metadata as Record<string, unknown>) : {};
  const name = clean(fm.name, 64);
  if (!name) throw new ManifestError("SKILL.md frontmatter needs a name.");
  const description = clean(fm.description, 1024);
  if (!description) throw new ManifestError("SKILL.md frontmatter needs a description.");
  const authorRaw = fm.author ?? meta.author;
  const author = clean(authorRaw && typeof authorRaw === "object" ? (authorRaw as Record<string, unknown>).name : authorRaw, 80) || "unknown";
  const version = clean(fm.version ?? meta.version, 32) || "0.0.0";
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(version)) throw new ManifestError("The skill version may use letters, digits and . + _ - only.");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!slug) throw new ManifestError("The skill name needs at least one letter or digit.");
  return { name, slug, version, description, author };
}
