import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dir, "..");

/** One Node ESM file, with reproducible module labels and bundled licence notices. */
export async function buildJoinBundle(): Promise<string> {
  const build = await Bun.build({ entrypoints: [path.join(root, "scripts/network-join.ts")], root, target: "node", format: "esm", minify: false, sourcemap: "none" });
  if (!build.success || build.outputs.length !== 1) throw new Error("Network join bundle failed.");
  const licences = await Promise.all(["viem", "@noble/curves", "@noble/hashes", "@scure/base", "@scure/bip32", "@scure/bip39", "abitype", "ox"].map(async (name) => {
    const pkg = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8"));
    const text = await readFile(path.join(root, "node_modules", name, "LICENSE"), "utf8");
    return `${name} ${pkg.version}\n${text}`;
  }));
  const code = (await build.outputs[0].text()).replace(/^#!.*\n/, "").replace(/^\/\/ (\S+\.(?:[cm]?[jt]s|json))$/gm, (_, label: string) => {
    const modules = label.lastIndexOf("node_modules/");
    const own = label.lastIndexOf("scripts/");
    return "// " + (modules >= 0 ? label.slice(modules) : own >= 0 ? label.slice(own) : label.replace(/^(\.\.\/)+/, ""));
  });
  return `#!/usr/bin/env node\n// AnyRoute host registration. Source: scripts/network-join.ts. Requires Node 22 or later.\n/* Bundled third-party licence notices\n${licences.join("\n")}\n*/\n${code}`;
}
if (import.meta.main) {
  const code = await buildJoinBundle();
  const file = path.join(root, "web/public/network/join.mjs");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, code);
  console.log(`web/public/network/join.mjs ${Buffer.byteLength(code)} bytes sha256 ${createHash("sha256").update(code).digest("hex")}`);
}
