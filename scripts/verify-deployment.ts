import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyDeployment, makeRpcReader, type DeploymentManifest } from "./deployment-verification";
import rhcConfig from "../config/rhc-mainnet.json";
import { loadDeploymentBuild, type BuildRecord } from "./deployment-build.ts";

function usage(): never {
  console.error("Usage: bun scripts/verify-deployment.ts <manifest.json> --rpc-url <public-rpc-url> --build-record <reviewed-build.json>");
  process.exit(2);
}

const manifestPath = process.argv[2];
const rpcIndex = process.argv.indexOf("--rpc-url");
const rpcUrl = rpcIndex >= 0 ? process.argv[rpcIndex + 1] : undefined;
const buildIndex = process.argv.indexOf("--build-record");
const buildPath = buildIndex >= 0 ? process.argv[buildIndex + 1] : undefined;
if (!manifestPath || !rpcUrl || !buildPath) usage();

try {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as DeploymentManifest;
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "contracts/src", "contracts/foundry.toml", "bun.lock"], { stdio: "ignore" });
  if (execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "contracts/src"], { encoding: "utf8" }).trim()) throw new Error("Uncommitted compiler sources");
  const record = JSON.parse(await readFile(resolve(buildPath), "utf8")) as BuildRecord;
  const build = await loadDeploymentBuild(record, resolve(import.meta.dir, ".."), sourceRevision);
  const report = await verifyDeployment(manifest, makeRpcReader(rpcUrl), sourceRevision, rhcConfig.safe141.singleton as `0x${string}`, build);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "verification_failed", category: error instanceof Error && /timeout/i.test(error.name) ? "rpc_timeout" : "rpc_or_input_error" }, null, 2));
  process.exitCode = 1;
}
