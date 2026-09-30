import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SkillFile } from "../../src/skills/archive.ts";

// Loads the skill corpus in test/fixtures/skills (benign/ and malicious/, one folder per skill) as the scanner sees it.

export const SKILL_FIXTURES = join(import.meta.dir, "../fixtures/skills");

export function loadSkillDir(dir: string): SkillFile[] {
  const out: SkillFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split("\\").join("/"), type: "file", mode: st.mode & 0o777, data: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(dir);
  return out;
}

export const corpus = (kind: "benign" | "malicious") =>
  readdirSync(join(SKILL_FIXTURES, kind))
    .sort()
    .map((name) => ({ name, dir: join(SKILL_FIXTURES, kind, name), files: loadSkillDir(join(SKILL_FIXTURES, kind, name)) }));
