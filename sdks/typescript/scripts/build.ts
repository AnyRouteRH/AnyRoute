// Build dist/: an ESM and a CJS bundle (with @anyroute/client bundled in from packages/client/src, so nothing is
// duplicated in source and there is no unpublished runtime dependency), plus .d.ts files. The client's declarations
// are emitted into dist/types/client/ and the SDK's declarations point at them.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const tsc = (project: string) => {
  const r = Bun.spawnSync(["bunx", "tsc", "-p", project], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`tsc -p ${project} failed`);
};

for (const format of ["esm", "cjs"] as const) {
  const out = await Bun.build({
    entrypoints: [join(root, "src/index.ts")],
    outdir: dist,
    naming: format === "esm" ? "index.js" : "index.cjs",
    format,
    target: "node",
    tsconfig: join(root, "tsconfig.json"),
  });
  if (!out.success) {
    for (const log of out.logs) console.error(log);
    throw new Error(`bundle (${format}) failed`);
  }
}

tsc("tsconfig.client-types.json");
tsc("tsconfig.build.json");

// Point the SDK's declarations at the bundled client declarations.
for (const f of readdirSync(join(dist, "types"))) {
  if (!f.endsWith(".d.ts")) continue;
  const p = join(dist, "types", f);
  writeFileSync(p, readFileSync(p, "utf8").replaceAll(`"@anyroute/client"`, `"./client/index.js"`));
}
console.log("built dist/index.js, dist/index.cjs and dist/types/");
