import { keccak256, type Hex } from "viem";

export type RuntimeProof = {
  /** Compiler output, before constructor immutable substitutions. */
  object: Hex;
  immutableReferences: Record<string, Array<{ start: number; length: number }>>;
  /** Independently reviewed constructor values; never derive these from observed runtime. */
  immutableValues: Record<string, Hex>;
};
export type DeploymentBuild = {
  sourceRevision: string;
  contracts: Record<string, RuntimeProof | { externalHash: Hex }>;
};

const hex = (value: unknown): value is Hex => typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);

/** Remove only the compiler's terminal CBOR map, retaining every executable byte. */
export function executableRuntime(code: Hex): string {
  const body = code.slice(2).toLowerCase();
  if (body.length < 4) return body;
  const bytes = Number.parseInt(body.slice(-4), 16);
  const start = body.length - 4 - bytes * 2;
  if (start >= 0) {
    const metadata = body.slice(start, -4);
    // Solidity records its compiler version as the CBOR key "solc" and a 3-byte value.
    if (/^a[1-9]/.test(metadata) && /64736f6c6343[0-9a-f]{6}/.test(metadata)) return body.slice(0, start);
  }
  return body;
}

/** Compare code and exact immutable values. Missing or overlapping offsets fail closed. */
export function runtimeMatches(actual: Hex | undefined, proof: RuntimeProof | { externalHash: Hex }): boolean {
  if (!hex(actual)) return false;
  if ("externalHash" in proof) return /^0x[0-9a-fA-F]{64}$/.test(proof.externalHash) && keccak256(actual).toLowerCase() === proof.externalHash.toLowerCase();
  if (!hex(proof.object) || !proof.immutableReferences || !proof.immutableValues) return false;
  let expected = executableRuntime(proof.object);
  const observed = executableRuntime(actual);
  if (!expected || expected.length !== observed.length) return false;
  const used = new Set<number>();
  for (const [id, refs] of Object.entries(proof.immutableReferences)) {
    const value = proof.immutableValues[id];
    if (!hex(value) || !Array.isArray(refs) || !refs.length) return false;
    for (const { start, length } of refs) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || (start + length) * 2 > expected.length || value.length !== 2 + length * 2) return false;
      for (let byte = start; byte < start + length; byte++) {
        if (used.has(byte)) return false;
        used.add(byte);
      }
      expected = expected.slice(0, start * 2) + value.slice(2).toLowerCase() + expected.slice((start + length) * 2);
    }
  }
  // An extra declared immutable value usually means the record refers to an older build.
  if (Object.keys(proof.immutableValues).some(id => !Object.hasOwn(proof.immutableReferences, id))) return false;
  return expected === observed;
}
