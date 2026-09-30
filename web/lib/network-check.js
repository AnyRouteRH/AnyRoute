import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
export function checkerDigest(cwd = process.cwd()) {
  return createHash("sha256").update(readFileSync(path.join(cwd, "public/network/check.sh"))).digest("hex");
}
