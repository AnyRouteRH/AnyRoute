// Reads the data inventory when the site is built, so the /keep page and /keep/inventory.json always follow the router's
// descriptions of what it stores. Server-side only: it reads files and asks git.
//
// The inventory is generated from the router's source by `bun scripts/gen-inventory.ts` (the image build runs it in its own stage), from
// src/privacy and the live schema in src/db/schema.ts. A test in the router's suite fails when the committed copy of the file differs
// from what the code generates, so the page cannot describe a schema the router no longer has.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REPO_URL = "https://github.com/AnyRouteRH/AnyRoute";
export const INVENTORY_FILE = "app/keep/inventory.generated.json";

/** Where the generated inventory is: KEEP_INVENTORY_FILE, else app/keep/ of the web folder (the build's working directory). */
export function inventoryPath() {
  const candidates = [process.env.KEEP_INVENTORY_FILE, path.resolve(process.cwd(), INVENTORY_FILE), path.resolve(process.cwd(), "web", INVENTORY_FILE)].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`The data inventory was not found (looked in ${candidates.join(", ")}); generate it with: bun scripts/gen-inventory.ts`);
  return found;
}

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/** Parse and check an inventory file's text. The hash is of the exact text, which is what /keep/inventory.json serves. */
export function parseInventory(text) {
  const doc = JSON.parse(text);
  if (doc?.format !== "anyroute.data-inventory/1") throw new Error("The data inventory has an unknown format.");
  if (!Array.isArray(doc.postgres?.tables) || !doc.postgres.tables.length) throw new Error("The data inventory lists no tables.");
  if (!doc.summary?.headline || !Array.isArray(doc.categories)) throw new Error("The data inventory has no summary.");
  return { text, doc, sha256: sha256Hex(text) };
}

export function loadInventory(file = inventoryPath()) {
  return parseInventory(fs.readFileSync(file, "utf8"));
}

const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * The commit the site was built from: ANYROUTE_BUILD_COMMIT when the build sets it (the image build cannot see git), else git's
 * HEAD for the folder the build runs in. `dirty` is true when tracked files differ from that commit. Null when neither is known.
 */
export function buildCommit(env = process.env, git = defaultGit) {
  const given = String(env.ANYROUTE_BUILD_COMMIT || "").trim().toLowerCase();
  if (given) return COMMIT.test(given) ? { sha: given, source: "build setting", dirty: false } : null;
  try {
    const sha = git(["rev-parse", "HEAD"]).trim().toLowerCase();
    if (!COMMIT.test(sha)) return null;
    let dirty = false;
    try {
      dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim().length > 0;
    } catch {
      /* unknown: leave it unmarked */
    }
    return { sha, source: "git", dirty };
  } catch {
    return null;
  }
}

function defaultGit(args) {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
}

const AB_REQUEST = { yes: "Per request", aggregate: "Summed from requests", no: "Not about requests" };
export const aboutRequestLabel = (v) => AB_REQUEST[v] ?? "Not stated";

/** Tables grouped by category, in the order the inventory lists the categories. */
export function tablesByCategory(doc) {
  return doc.categories.map((category) => ({ ...category, tables: doc.postgres.tables.filter((t) => t.category === category.id) })).filter((c) => c.tables.length);
}

/** A file path in the router's repository, as a link to the file on the main branch. */
export const sourceUrl = (file) => `${REPO_URL}/blob/main/${file}`;
