import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { keccak256, type Hex } from "viem";
import type { DeploymentBuild, RuntimeProof } from "./runtime-proof.ts";

/** A committed, independently reviewed build record. Hashes must come from the audited build. */
export type BuildRecord = {
  schema: "anyroute.build/v1";
  sourceRevision: string;
  inputs: Record<string, string>;
  contracts: Record<string, { artifact: string; sha256: string; immutableValues: RuntimeProof["immutableValues"] } | { externalHash: Hex }>;
};
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readInside(root: string, path: string): Promise<Uint8Array> {
  const absolute = await realpath(resolve(root, path));
  const rel = relative(await realpath(root), absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Build record path outside root");
  return readFile(absolute);
}

export async function loadDeploymentBuild(record: BuildRecord, root: string, expectedRevision: string): Promise<DeploymentBuild> {
  if (record.schema !== "anyroute.build/v1" || record.sourceRevision !== expectedRevision || !record.inputs || !record.contracts) throw new Error("Build record revision/schema mismatch");
  for (const required of ["contracts/foundry.toml", "bun.lock"]) if (!(required in record.inputs)) throw new Error("Build record omits compiler or dependency state");
  for (const [path, expected] of Object.entries(record.inputs)) {
    if (!/^[a-f0-9]{64}$/.test(expected) || sha(await readInside(root, path)) !== expected) throw new Error("Build input changed");
  }
  const contracts: DeploymentBuild["contracts"] = {};
  for (const [name, proof] of Object.entries(record.contracts)) {
    if ("externalHash" in proof) { contracts[name] = proof; continue; }
    if (!proof.artifact.startsWith("contracts/out/")) throw new Error("Expected Foundry output artifact");
    const bytes = await readInside(root, proof.artifact);
    if (!/^[a-f0-9]{64}$/.test(proof.sha256) || sha(bytes) !== proof.sha256) throw new Error("Compiled artifact changed");
    const artifact = JSON.parse(new TextDecoder().decode(bytes));
    const meta = artifact.rawMetadata ? JSON.parse(artifact.rawMetadata) : artifact.metadata;
    if (!meta?.sources || !Object.keys(meta.sources).length || !meta?.compiler?.version?.startsWith("0.8.26+")) throw new Error("Compiler source metadata missing");
    // Every compiled input, including dependencies, must be explicitly hash-bound.
    for (const source of Object.keys(meta.sources)) {
      const path = relative(root, resolve(root, "contracts", source)).replaceAll("\\", "/");
      if (!(path in record.inputs)) throw new Error("Build record omits a compiler source");
      if (keccak256(await readInside(root, path)) !== meta.sources[source].keccak256) throw new Error("Compiler source differs from reviewed input");
    }
    const deployed = artifact.deployedBytecode;
    if (typeof deployed?.object !== "string") throw new Error("Runtime bytecode missing");
    contracts[name] = { object: deployed.object.startsWith("0x") ? deployed.object : `0x${deployed.object}`, immutableReferences: deployed.immutableReferences ?? {}, immutableValues: proof.immutableValues };
  }
  return { sourceRevision: record.sourceRevision, contracts };
}
