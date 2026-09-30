// Builds the single-file program: `bun packages/private/scripts/build.ts` writes web/public/private.mjs (served at
// /private.mjs on the site) and packages/private/dist/anyroute-private.mjs (the file the npm package ships as its bin).
// Both are the same bytes. The file is not minified, so it can be read; the SHA-256 of what is served is shown on the
// documentation page, which reads it from the same file when the site is built.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

const BANNER = `// anyroute-private: a local OpenAI-compatible proxy that sends every call to AnyRoute over Tor, on the unlinkable
// lane, paid with blind tokens. Apache License 2.0. Source: packages/private in the AnyRoute repository.
// Run it with Node 20 or later: node private.mjs start   (buy and status are the other commands)
// This is one file with everything it needs bundled in, not minified. Its SHA-256 is on the documentation page.
//
// Bundled third-party code
//   @cloudflare/blindrsa-ts 0.4.6. Copyright (c) 2023 Cloudflare, Inc. Apache License 2.0, http://www.apache.org/licenses/LICENSE-2.0
//   sjcl 1.0.9, which blindrsa-ts includes. Copyright (c) 2009-2015, Emily Stark, Mike Hamburg and Dan Boneh at Stanford University.
//     All rights reserved. Used under the BSD 2-Clause licence: redistributions in binary form must reproduce this copyright
//     notice, the list of conditions and the following disclaimer. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
//     CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
//     MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
//     CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
//     BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
//     INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
//     NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

/** The bundle's bytes. The same on every machine: the module labels Bun writes are made independent of where the checkout is. */
export async function buildBundle(): Promise<string> {
  const result = await Bun.build({ entrypoints: [path.join(root, "packages/private/src/main.ts")], root, target: "node", format: "esm", minify: false, sourcemap: "none" });
  if (!result.success || result.outputs.length !== 1) throw new Error("Build failed:\n" + result.logs.map(String).join("\n"));
  let code = await result.outputs[0].text();
  code = code.replace(/^#!.*\n/, "");
  // Bun labels each module with its path, relative to wherever the build was started. Keep the part that is the same
  // everywhere: node_modules/... or packages/private/... or packages/client/...
  code = code.replace(/^\/\/ (\S+\.(?:[cm]?[jt]s|json))$/gm, (_, p: string) => {
    const modules = p.lastIndexOf("node_modules/");
    if (modules >= 0) return "// " + p.slice(modules);
    const own = [...p.matchAll(/packages\/(?:private|client)\//g)].at(-1);
    return "// " + (own ? p.slice(own.index) : p.replace(/^(\.\.\/)+/, ""));
  });
  return "#!/usr/bin/env node\n" + BANNER + code;
}

if (import.meta.main) {
  const code = await buildBundle();
  const sha = createHash("sha256").update(code).digest("hex");
  for (const [file, mode] of [
    [path.join(root, "web/public/private.mjs"), 0o644],
    [path.join(root, "packages/private/dist/anyroute-private.mjs"), 0o755],
  ] as const) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, code);
    await fs.chmod(file, mode);
  }
  console.log(`web/public/private.mjs  ${Buffer.byteLength(code)} bytes  sha256 ${sha}`);
}
