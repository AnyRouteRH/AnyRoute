import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifyDeployment, makeRpcReader, type DeploymentManifest } from "./deployment-verification";

function usage(): never {
  console.error("Usage: bun scripts/verify-deployment.ts <manifest.json> --rpc-url <public-rpc-url>");
  process.exit(2);
}

const manifestPath = process.argv[2];
const rpcIndex = process.argv.indexOf("--rpc-url");
const rpcUrl = rpcIndex >= 0 ? process.argv[rpcIndex + 1] : undefined;
if (!manifestPath || !rpcUrl) usage();

try {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as DeploymentManifest;
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const report = await verifyDeployment(manifest, makeRpcReader(rpcUrl), sourceRevision);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
