import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";

// OpenZeppelin MerkleProof-compatible tree: commutative (sorted-pair) keccak256 hashing,
// leaves double-hashed to rule out second-preimage attacks. Odd nodes are promoted.

const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export class MerkleTree {
  readonly layers: Hex[][];
  constructor(readonly leaves: Hex[]) {
    if (!leaves.length) throw new Error("empty tree");
    const layers: Hex[][] = [leaves.slice()];
    while (layers[layers.length - 1].length > 1) {
      const prev = layers[layers.length - 1];
      const next: Hex[] = [];
      for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
      layers.push(next);
    }
    this.layers = layers;
  }
  get root(): Hex {
    return this.layers[this.layers.length - 1][0];
  }
  proof(index: number): Hex[] {
    if (index < 0 || index >= this.leaves.length) throw new Error("leaf index out of range");
    const proof: Hex[] = [];
    for (let l = 0; l < this.layers.length - 1; l++) {
      const layer = this.layers[l];
      const sibling = index ^ 1;
      if (sibling < layer.length) proof.push(layer[sibling]);
      index = Math.floor(index / 2);
    }
    return proof;
  }
  static verify(leaf: Hex, proof: Hex[], root: Hex): boolean {
    let h = leaf;
    for (const p of proof) h = hashPair(h, p);
    return h.toLowerCase() === root.toLowerCase();
  }
}

/** Receipt leaf: keccak256(bytes.concat(keccak256(canonicalBytes || signatureBytes))). */
export function receiptLeaf(canonicalBytes: Uint8Array, signature: Uint8Array): Hex {
  const inner = keccak256(concat([canonicalBytes, signature]));
  return keccak256(inner);
}

/** Spent-root leaf: keccak256(bytes.concat(keccak256(abi.encode(keyHash, cumulativeSpent)))). */
export function spentLeaf(chainKeyHash: Hex, cumulativeSpentUsdg: bigint): Hex {
  const inner = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [chainKeyHash, cumulativeSpentUsdg]));
  return keccak256(inner);
}
