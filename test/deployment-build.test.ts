import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { keccak256, toHex } from "viem";
import { loadDeploymentBuild, type BuildRecord } from "../scripts/deployment-build.ts";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "reviewed-build-")); dirs.push(root);
  await mkdir(join(root, "contracts/out/Sample.sol"), { recursive: true }); await mkdir(join(root, "contracts/src"));
  const source = "pragma solidity 0.8.26; contract Sample {}";
  const artifact = JSON.stringify({ metadata: { compiler: { version: "0.8.26+commit.8a97fa7a" }, sources: { "src/Sample.sol": { keccak256: keccak256(toHex(source)) } } }, deployedBytecode: { object: "0x6001", immutableReferences: {} } });
  const inputs = { "contracts/foundry.toml": "pinned settings", "bun.lock": "pinned dependencies", "contracts/src/Sample.sol": source };
  for (const [path, text] of Object.entries(inputs)) await writeFile(join(root, path), text);
  await writeFile(join(root, "contracts/out/Sample.sol/Sample.json"), artifact);
  const record: BuildRecord = { schema: "anyroute.build/v1", sourceRevision: "reviewed-revision", inputs: Object.fromEntries(Object.entries(inputs).map(([path, text]) => [path, hash(text)])), contracts: { sample: { artifact: "contracts/out/Sample.sol/Sample.json", sha256: hash(artifact), immutableValues: {} } } };
  return { root, record };
}
test("reviewed build binds compiler output, source bytes, settings and dependency state", async () => {
  const { root, record } = await fixture();
  expect((await loadDeploymentBuild(record, root, "reviewed-revision")).contracts.sample).toMatchObject({ object: "0x6001" });
  await expect(loadDeploymentBuild(record, root, "other-revision")).rejects.toThrow("revision");
  delete record.inputs["bun.lock"];
  await expect(loadDeploymentBuild(record, root, "reviewed-revision")).rejects.toThrow("omits");
});
test("changing a source, dependency, output or metadata source hash fails closed", async () => {
  for (const path of ["contracts/src/Sample.sol", "bun.lock", "contracts/out/Sample.sol/Sample.json"]) {
    const { root, record } = await fixture(); await writeFile(join(root, path), "changed");
    await expect(loadDeploymentBuild(record, root, "reviewed-revision")).rejects.toThrow("changed");
  }
  const { root, record } = await fixture(); await writeFile(join(root, "contracts/src/Sample.sol"), "changed"); record.inputs["contracts/src/Sample.sol"] = hash("changed");
  await expect(loadDeploymentBuild(record, root, "reviewed-revision")).rejects.toThrow("Compiler source differs");
});
test("build-record traversal and symlink escapes cannot read outside the candidate", async () => {
  const { root, record } = await fixture(); const outside = await mkdtemp(join(tmpdir(), "outside-build-")); dirs.push(outside);
  await writeFile(join(outside, "public-fixture"), "fixture"); await symlink(join(outside, "public-fixture"), join(root, "escape"));
  record.inputs.escape = hash("fixture");
  await expect(loadDeploymentBuild(record, root, "reviewed-revision")).rejects.toThrow("outside root");
});
