import { expect, test } from "bun:test";
import { keccak256, type Hex } from "viem";
import { runtimeMatches, executableRuntime, type RuntimeProof } from "../scripts/runtime-proof.ts";

const proof: RuntimeProof = { object: "0x600000006001", immutableReferences: { "1": [{ start: 1, length: 3 }] }, immutableValues: { "1": "0x123456" } };
test("runtime proof compares executable instructions and exact constructor immutable values", () => {
  expect(runtimeMatches("0x601234566001", proof)).toBe(true);
  expect(runtimeMatches("0x611234566001", proof)).toBe(false);
  expect(runtimeMatches("0x601234576001", proof)).toBe(false);
  expect(runtimeMatches("0x601234566001", { ...proof, immutableValues: {} })).toBe(false);
  expect(runtimeMatches("0x", proof)).toBe(false);
});
test("malformed, overlapping or stale immutable references cannot hide executable changes", () => {
  for (const refs of [[{ start: -1, length: 3 }], [{ start: 20, length: 3 }], [{ start: 1, length: 3 }, { start: 2, length: 3 }]]) {
    expect(runtimeMatches("0x601234566001", { ...proof, immutableReferences: { "1": refs } })).toBe(false);
  }
  expect(runtimeMatches("0x601234566001", { ...proof, immutableValues: { "1": "0x12" } })).toBe(false);
  expect(runtimeMatches("0x601234566001", { ...proof, immutableValues: { ...proof.immutableValues, "2": "0x00" } })).toBe(false);
});
test("metadata normalization retains all instructions before a genuine compiler trailer", () => {
  const metadata = "a164736f6c634300081a";
  const withMetadata = (body: string) => `0x${body}${metadata}000a` as Hex;
  expect(executableRuntime(withMetadata("6001"))).toBe("6001");
  expect(runtimeMatches(withMetadata("6001"), { object: "0x6001", immutableReferences: {}, immutableValues: {} })).toBe(true);
  expect(runtimeMatches(withMetadata("6002"), { object: "0x6001", immutableReferences: {}, immutableValues: {} })).toBe(false);
  expect(executableRuntime("0x60010009")).toBe("60010009");
});
test("external infrastructure requires its reviewed full runtime hash", () => {
  expect(runtimeMatches("0x6001", { externalHash: keccak256("0x6001") })).toBe(true);
  expect(runtimeMatches("0x6002", { externalHash: keccak256("0x6001") })).toBe(false);
});
