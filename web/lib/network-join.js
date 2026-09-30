import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
export function joinDigest(cwd = process.cwd()) {
  return createHash("sha256").update(readFileSync(path.join(cwd, "public/network/join.mjs"))).digest("hex");
}
