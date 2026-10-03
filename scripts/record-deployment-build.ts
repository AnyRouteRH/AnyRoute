/** Compile first, then hash a clean candidate and operator-reviewed immutable/external inputs. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { loadDeploymentBuild, type BuildRecord } from "./deployment-build.ts";
import type { RuntimeProof } from "./runtime-proof.ts";
import type { Hex } from "viem";

const root = resolve(import.meta.dir, "..");
const input = process.argv[2];
if (!input) throw new Error("Usage: bun scripts/record-deployment-build.ts <reviewed-runtime-inputs.json> > <build-record.json>");
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "contracts", "config", "bun.lock"], { cwd: root, stdio: "ignore" });
if (execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "contracts/src", "contracts/script", "config"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Uncommitted build inputs");
execFileSync("bash", ["scripts/foundry.sh", "forge", "build", "--root", "contracts", "--force"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const requests = JSON.parse(await readFile(resolve(input), "utf8")) as Record<string, { artifact: string; immutableValues: RuntimeProof["immutableValues"] } | { externalHash: Hex }>;
const record: BuildRecord = { schema: "anyroute.build/v1", sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), inputs: {}, contracts: {} };
async function bind(path: string) {
  const actual = await realpath(resolve(root, path));
  const rel = relative(root, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Build path outside checkout");
  const bytes = await readFile(actual);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bytes, digest };
}
for (const path of ["bun.lock", "contracts/foundry.toml"]) record.inputs[path] = (await bind(path)).digest;
for (const [name, request] of Object.entries(requests)) {
  if ("externalHash" in request) { record.contracts[name] = request; continue; }
  if (!request.artifact.startsWith("contracts/out/")) throw new Error("Expected contracts/out artifact path");
  const { bytes, digest } = await bind(request.artifact);
  const artifact = JSON.parse(bytes.toString());
  const metadata = artifact.rawMetadata ? JSON.parse(artifact.rawMetadata) : artifact.metadata;
  for (const source of Object.keys(metadata.sources)) {
    const path = relative(root, resolve(root, "contracts", source)).replaceAll("\\", "/");
    record.inputs[path] = (await bind(path)).digest;
  }
  record.contracts[name] = { ...request, sha256: digest };
}
await loadDeploymentBuild(record, root, record.sourceRevision);
console.log(JSON.stringify(record, null, 2));
