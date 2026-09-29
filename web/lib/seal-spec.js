// Reads the SEAL specification (spec/ at the repository root) when the site is built, so the /seal and /spec pages
// and /seal/status.json always follow the documents as they are. Server-side only: it reads files.
import fs from "node:fs";
import path from "node:path";
import { inlineLinks, parseBlocks, plainText, renderMarkdown, slugify } from "./spec-markdown.js";

export const REPO_URL = "https://github.com/AnyRouteRH/AnyRoute";
export const SPEC_SOURCE_URL = `${REPO_URL}/tree/main/spec`;
export const SPEC_LICENSE_URL = `${REPO_URL}/blob/main/spec/LICENSE`;

/** The spec folder: SEAL_SPEC_DIR, else ../spec from the web folder (the repository layout and the image build). */
export function specDir() {
  const candidates = [process.env.SEAL_SPEC_DIR, path.resolve(process.cwd(), "../spec"), path.resolve(process.cwd(), "spec")].filter(Boolean);
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, "README.md")));
  if (!found) throw new Error(`SEAL spec not found (looked in ${candidates.join(", ")}); the site build needs the repository's spec/ folder`);
  return found;
}

/** The documents in the folder: README as the index, numbered documents in order, then CHANGELOG. */
export function listDocs(dir = specDir()) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const numbered = files.filter((f) => /^\d{4}-[\w-]+\.md$/.test(f)).sort();
  const docs = [];
  if (files.includes("README.md")) docs.push({ file: "README.md", slug: "", number: null, url: "/spec/" });
  for (const file of numbered) docs.push({ file, slug: file.replace(/\.md$/, ""), number: file.slice(0, 4), url: `/spec/${file.replace(/\.md$/, "")}/` });
  if (files.includes("CHANGELOG.md")) docs.push({ file: "CHANGELOG.md", slug: "changelog", number: null, url: "/spec/changelog/" });
  for (const doc of docs) {
    const h1 = fs.readFileSync(path.join(dir, doc.file), "utf8").match(/^# +(.+?)\s*$/m);
    doc.title = h1 ? plainText(h1[1]) : doc.file;
    // "SEAL 0001: Attestation" -> "Attestation"
    doc.shortTitle = doc.number ? doc.title.replace(new RegExp(`^SEAL\\s+${doc.number}:\\s*`), "") : doc.file === "README.md" ? "Overview" : doc.title;
  }
  return docs;
}

/**
 * Where a link in a spec document points on the site: another spec document becomes its /spec page, anything else
 * in the repository becomes its file on GitHub, and web or mail addresses and fragments stay as written.
 */
export function resolveSpecHref(href, docs) {
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false };
  const hash = href.indexOf("#");
  const file = hash < 0 ? href : href.slice(0, hash);
  const frag = hash < 0 ? "" : href.slice(hash);
  const target = path.posix.normalize(path.posix.join("spec", file)).replace(/\/+$/, "");
  if (target.startsWith("..") || path.posix.isAbsolute(target)) return null;
  const doc = docs.find((d) => `spec/${d.file}` === target);
  if (doc) return { href: doc.url + frag, external: false };
  return { href: `${REPO_URL}/blob/main/${target}${frag}`, external: true };
}

/** A one-sentence-or-so summary for page metadata: the Abstract's first paragraph, else the first paragraph. */
function summary(src) {
  const blocks = parseBlocks(src);
  const at = blocks.findIndex((b) => b.type === "heading" && /^abstract$/i.test(plainText(b.text)));
  const para = blocks.slice(at < 0 ? 0 : at).find((b) => b.type === "paragraph");
  const text = para ? plainText(para.text).replace(/\s+/g, " ") : "";
  if (text.length <= 220) return text;
  const cut = text.slice(0, 220);
  const end = cut.lastIndexOf(". ");
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

/** Load and render one document by slug ("" for the README), with the spec version from the changelog. */
export function loadDoc(slug, dir = specDir()) {
  const docs = listDocs(dir);
  const doc = docs.find((d) => d.slug === slug);
  if (!doc) return null;
  const src = fs.readFileSync(path.join(dir, doc.file), "utf8");
  const rendered = renderMarkdown(src, { stripTitle: true, resolveHref: (href) => resolveSpecHref(href, docs) });
  const changelog = path.join(dir, "CHANGELOG.md");
  const version = fs.existsSync(changelog) ? specVersion(fs.readFileSync(changelog, "utf8")) : { version: null, date: null, unreleased: false };
  return { ...doc, src, docs, version, description: summary(src), ...rendered, title: rendered.title?.text || doc.title };
}

// ---------- the README: lanes, guarantees, parties, limits, status ----------

/** Level-2 sections of a document: heading text -> blocks. */
function sections(src) {
  const out = new Map();
  let current = null;
  for (const block of parseBlocks(src)) {
    if (block.type === "heading" && block.level <= 2) {
      current = block.level === 2 ? plainText(block.text) : null;
      if (current) out.set(current, []);
    } else if (current) out.get(current).push(block);
  }
  return out;
}

const findSection = (map, re) => {
  for (const [title, blocks] of map) if (re.test(title)) return { title, blocks };
  return null;
};

/** Rows of a table as objects keyed by the header (slugged with underscores; an empty header cell is "id"). */
function rowsOf(table) {
  const keys = table.head.map((h) => slugify(plainText(h)).replace(/-/g, "_") || "id");
  return table.rows.map((cells) => Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? ""])));
}

const firstTable = (blocks) => blocks?.find((b) => b.type === "table") || null;
const paragraphs = (blocks) => (blocks || []).filter((b) => b.type === "paragraph").map((b) => b.text);

/** Implemented, planned, or partly built (anything else), read from the start of the status text. */
export function statusState(status) {
  const s = plainText(status).trim();
  if (/^implemented\b/i.test(s)) return "implemented";
  if (/^planned\b/i.test(s)) return "planned";
  return "partial";
}

/**
 * Parse the README's lanes, guarantees, parties, honest limits and status table. Cells keep their Markdown (md
 * fields) so pages can render them; plain-text fields are for status.json. Throws when the status table is missing.
 */
export function parseReadme(src) {
  const map = sections(src);

  const lanesSec = findSection(map, /^lanes$/i);
  const lanes = lanesSec && firstTable(lanesSec.blocks) ? rowsOf(firstTable(lanesSec.blocks)) : [];

  const gSec = findSection(map, /^guarantees/i);
  const guarantees = (gSec && firstTable(gSec.blocks) ? rowsOf(firstTable(gSec.blocks)) : []).map((row) => {
    const cell = row.target ?? Object.values(row)[1] ?? "";
    const m = cell.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    return { id: plainText(row.id), name: m ? plainText(m[1]).replace(/\.$/, "") : "", target: plainText(m ? m[2] : cell), md: cell };
  });

  const pSec = findSection(map, /^parties$/i);
  const parties = (pSec && firstTable(pSec.blocks) ? rowsOf(firstTable(pSec.blocks)) : []).map((row) => ({
    symbol: plainText(row.symbol ?? ""),
    party: plainText(row.party ?? ""),
    learns: plainText(row.learns ?? ""),
    does_not_learn: plainText(row.does_not_learn ?? ""),
    md: row,
  }));

  const limSec = findSection(map, /^honest limits$/i);
  const limitsList = limSec?.blocks.find((b) => b.type === "list");
  const honestLimits = (limitsList?.items || []).map((it) => ({ text: plainText(it.text), md: it.text }));

  const stSec = findSection(map, /^status of this repository$/i);
  const stTable = stSec && firstTable(stSec.blocks);
  if (!stTable) throw new Error('spec/README.md has no table under "## Status of this repository"');
  const status = rowsOf(stTable).map((row) => {
    const spec = plainText(row.spec ?? "")
      .split(/[,\s]+/)
      .filter((x) => /^\d{4}$/.test(x));
    const statusText = plainText(row.status ?? "");
    return {
      part: plainText(row.part ?? ""),
      spec,
      status: statusText,
      state: statusState(row.status ?? ""),
      off_by_default: /off by default/i.test(statusText),
      where: inlineLinks(row.where ?? "").map((l) => ({ text: l.text, path: l.href })),
      md: { part: row.part ?? "", status: row.status ?? "", where: row.where ?? "" },
    };
  });

  return {
    lanes: lanes.map((row) => ({ lane: plainText(row.lane ?? ""), path: plainText(row.path ?? ""), who_can_run_it: plainText(row.who_can_run_it ?? ""), payment: plainText(row.payment ?? ""), md: row })),
    lanesNote: paragraphs(lanesSec?.blocks),
    guarantees,
    guaranteesNote: paragraphs(gSec?.blocks),
    parties,
    honestLimits,
    honestLimitsNote: paragraphs(limSec?.blocks),
    status,
    statusNote: paragraphs(stSec?.blocks),
    intro: (() => {
      // The opening paragraph, before the first list or heading.
      const first = parseBlocks(src).find((b) => b.type === "paragraph");
      return first ? first.text : "";
    })(),
  };
}

/** The latest released version in CHANGELOG.md, its date, and whether an Unreleased section lists changes. */
export function specVersion(changelog) {
  const blocks = parseBlocks(changelog);
  let version = null;
  let date = null;
  let unreleased = false;
  let inUnreleased = false;
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 2) {
      const text = plainText(b.text);
      inUnreleased = /^\[?unreleased\]?/i.test(text);
      const m = text.match(/^\[?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\]?\s*(?:-\s*(\d{4}-\d{2}-\d{2}))?/);
      if (m && !version) {
        version = m[1];
        date = m[2] || null;
      }
    } else if (inUnreleased && b.type === "list" && b.items.length) unreleased = true;
  }
  return { version, date, unreleased };
}

/** Everything the /seal page needs, read from the spec folder. */
export function loadSeal(dir = specDir()) {
  const docs = listDocs(dir);
  const readme = parseReadme(fs.readFileSync(path.join(dir, "README.md"), "utf8"));
  const changelogFile = path.join(dir, "CHANGELOG.md");
  const version = fs.existsSync(changelogFile) ? specVersion(fs.readFileSync(changelogFile, "utf8")) : { version: null, date: null, unreleased: false };
  return { docs, readme, version, resolveHref: (href) => resolveSpecHref(href, docs) };
}

/** The machine-readable status served at /seal/status.json. */
export function sealStatusJson(dir = specDir()) {
  const { docs, readme, version } = loadSeal(dir);
  const docFor = (n) => docs.find((d) => d.number === n);
  const repoPath = (p) => {
    const r = resolveSpecHref(p, docs);
    return r ? r.href : null;
  };
  return {
    object: "seal.status",
    source: { readme: "spec/README.md", changelog: "spec/CHANGELOG.md", repository: SPEC_SOURCE_URL },
    spec: {
      version: version.version,
      released: version.date,
      unreleased_changes: version.unreleased,
      license: "Apache-2.0",
      license_url: SPEC_LICENSE_URL,
      documents: docs.map((d) => ({ number: d.number, title: d.title, file: `spec/${d.file}`, url: d.url })),
    },
    meaning: readme.statusNote.map((p) => plainText(p)),
    lanes: readme.lanes.map(({ md, ...rest }) => rest),
    guarantees: readme.guarantees.map(({ md, ...rest }) => rest),
    parties: readme.parties.map(({ md, ...rest }) => rest),
    honest_limits: readme.honestLimits.map((l) => l.text),
    status: readme.status.map((row) => ({
      part: row.part,
      spec: row.spec.map((n) => ({ number: n, url: docFor(n)?.url ?? null })),
      status: row.status,
      state: row.state,
      off_by_default: row.off_by_default,
      where: row.where.map((w) => ({ text: w.text, url: repoPath(w.path) })),
    })),
    live: "/api/v1/status",
  };
}
