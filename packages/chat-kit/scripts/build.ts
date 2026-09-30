// Build dist/: one ESM bundle (react, react-dom and react/jsx-runtime left to the host app), .d.ts files from tsc,
// and dist/styles.css from the same stylesheet the components inject.
// Run as `bun run build` (NODE_ENV=production), so JSX compiles to react/jsx-runtime, not the development runtime.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const out = await Bun.build({
  entrypoints: [join(root, "src/index.ts")],
  outdir: dist,
  naming: "index.js",
  format: "esm",
  target: "browser",
  external: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
  tsconfig: join(root, "tsconfig.json"),
  jsx: { runtime: "automatic", development: false },
});
if (!out.success) {
  for (const log of out.logs) console.error(log);
  throw new Error("bundle failed");
}

if (readFileSync(join(dist, "index.js"), "utf8").includes("jsx-dev-runtime")) throw new Error("built with the development JSX runtime: run with NODE_ENV=production");

const tsc = Bun.spawnSync(["bunx", "tsc", "-p", "tsconfig.build.json"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (tsc.exitCode !== 0) throw new Error("tsc -p tsconfig.build.json failed");

const { CHAT_KIT_CSS } = await import(join(root, "src/styles.ts"));
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "styles.css"), CHAT_KIT_CSS);
console.log("built dist/index.js, dist/styles.css and dist/types/");
