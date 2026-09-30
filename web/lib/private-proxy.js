// The single-file program served at /private.mjs (packages/private, built by `bun packages/private/scripts/build.ts` into
// public/private.mjs). Read when the site is built, so the SHA-256 on the documentation page is that of the file the
// site serves, not a number typed in by hand. Server-side only: it reads a file.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Where the file is: public/ under the web folder, which is the working directory of the build. */
export function privateProgramFile(cwd = process.cwd()) {
  return path.join(cwd, "public", "private.mjs");
}

/** Its SHA-256 (hex), size in bytes and version, from the bytes on disk. Throws if the file is missing, so a build cannot ship a page that names a file it does not have. */
export function privateProgram(file = privateProgramFile()) {
  const bytes = fs.readFileSync(file);
  const version = /^var VERSION = "(\d+\.\d+\.\d+)";$/m.exec(bytes.toString("utf8"))?.[1] ?? null;
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, version };
}
