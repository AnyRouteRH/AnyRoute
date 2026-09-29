import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";

// OpenZeppelin MerkleProof-compatible tree (receipt anchors, slashing evidence): commutative
// (sorted-pair) keccak256 hashing, leaves double-hashed to rule out second-preimage attacks. Odd nodes
// are promoted. Credits spent roots use SpentTree below instead.

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

// Credits spent tree (SPENT_TREE_VERSION 2). Leaves spentLeaf(keyHash, spent) sorted strictly ascending
// by keyHash; nodes keccak256(left || right) in position order (not the commutative pair hash above); an
// odd last node is promoted. The posted root binds the leaf count, and the empty tree is 0x00..00.
// Positions -1 and n are virtual sentinels, so every key hash without a leaf lies strictly between two
// adjacent positions: that non-inclusion proof lets Credits pay the key as if it spent 0.

const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const nodeHash = (left: Hex, right: Hex): Hex => keccak256(concat([left, right]));

/** The root Credits stores for a tree: 0 for no leaves, else keccak256(abi.encode(treeRoot, leafCount)). */
export function spentCommitment(treeRoot: Hex, leafCount: number | bigint): Hex {
  if (BigInt(leafCount) === 0n) return ZERO32;
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [treeRoot, BigInt(leafCount)]));
}

/** A leaf with its sibling path (bottom-up): Credits' SpentLeafProof. */
export type SpentNeighbour = { keyHash: Hex; cumulativeSpent: bigint; proof: Hex[] };
/** Arguments of Credits.finalizeWithdrawal (inclusion) or Credits.finalizeWithdrawalAbsent (absence). */
export type SpentProof =
  | { kind: "inclusion"; keyHash: Hex; cumulativeSpent: bigint; index: number; leafCount: number; proof: Hex[] }
  | { kind: "absence"; keyHash: Hex; cumulativeSpent: 0n; leafCount: number; gap: number; below: SpentNeighbour | null; above: SpentNeighbour | null };

/** Ignored by Credits: the argument standing for a sentinel neighbour. */
export const SENTINEL_NEIGHBOUR: SpentNeighbour = { keyHash: ZERO32, cumulativeSpent: 0n, proof: [] };

const normalizeKey = (h: string): Hex => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`invalid key hash ${h}`);
  return h.toLowerCase() as Hex;
};

export class SpentTree {
  readonly keys: Hex[];
  readonly spent: bigint[];
  private readonly ords: bigint[];
  private readonly layers: Hex[][];

  /** Leaves in any order; they are sorted by key hash. A repeated key hash is an error. */
  constructor(leaves: readonly (readonly [string, bigint])[]) {
    const sorted = leaves.map(([h, s]) => [normalizeKey(h), s] as const).map(([h, s]) => ({ h, s, o: BigInt(h) }));
    sorted.sort((a, b) => (a.o < b.o ? -1 : a.o > b.o ? 1 : 0));
    for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].o === sorted[i].o) throw new Error(`duplicate key hash ${sorted[i].h}`);
    for (const { s } of sorted) if (s < 0n) throw new Error("negative spend");
    this.keys = sorted.map((x) => x.h);
    this.spent = sorted.map((x) => x.s);
    this.ords = sorted.map((x) => x.o);
    const layers: Hex[][] = [this.keys.map((h, i) => spentLeaf(h, this.spent[i]))];
    while (layers[layers.length - 1].length > 1) {
      const prev = layers[layers.length - 1];
      const next: Hex[] = [];
      for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i]);
      layers.push(next);
    }
    this.layers = layers;
  }

  get leafCount() {
    return this.keys.length;
  }
  get treeRoot(): Hex {
    return this.leafCount ? this.layers[this.layers.length - 1][0] : ZERO32;
  }
  /** What Credits.postSpentRoot receives. */
  get root(): Hex {
    return spentCommitment(this.treeRoot, this.leafCount);
  }
  /** [keyHash, spent] in tree order, as stored with the root. */
  entries(): [Hex, bigint][] {
    return this.keys.map((h, i) => [h, this.spent[i]]);
  }

  proof(index: number): Hex[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.leafCount) throw new Error("leaf index out of range");
    const proof: Hex[] = [];
    for (let l = 0; l < this.layers.length - 1; l++) {
      const sibling = index ^ 1;
      if (sibling < this.layers[l].length) proof.push(this.layers[l][sibling]);
      index = Math.floor(index / 2);
    }
    return proof;
  }

  private neighbour(index: number): SpentNeighbour {
    return { keyHash: this.keys[index], cumulativeSpent: this.spent[index], proof: this.proof(index) };
  }

  /** The key's leaf, or the adjacent pair (sentinels as null) that brackets it. */
  prove(keyHash: string): SpentProof {
    const h = normalizeKey(keyHash);
    const o = BigInt(h);
    let lo = 0;
    let hi = this.leafCount; // first position whose key is >= o
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ords[mid] < o) lo = mid + 1;
      else hi = mid;
    }
    if (lo < this.leafCount && this.ords[lo] === o) return { kind: "inclusion", keyHash: h, cumulativeSpent: this.spent[lo], index: lo, leafCount: this.leafCount, proof: this.proof(lo) };
    return {
      kind: "absence",
      keyHash: h,
      cumulativeSpent: 0n,
      leafCount: this.leafCount,
      gap: lo,
      below: lo > 0 ? this.neighbour(lo - 1) : null,
      above: lo < this.leafCount ? this.neighbour(lo) : null,
    };
  }

  /** Mirrors Credits._treeRoot: null for an index outside the tree or a proof of the wrong length. */
  static treeRootFrom(leaf: Hex, index: number | bigint, leafCount: number | bigint, proof: readonly Hex[]): Hex | null {
    let i = BigInt(index);
    let width = BigInt(leafCount);
    if (i < 0n || i >= width) return null;
    let node = leaf;
    let used = 0;
    while (width > 1n) {
      if (i & 1n) {
        if (used === proof.length) return null;
        node = nodeHash(proof[used++], node);
      } else if (i + 1n < width) {
        if (used === proof.length) return null;
        node = nodeHash(node, proof[used++]);
      }
      i >>= 1n;
      width = (width >> 1n) + (width & 1n);
    }
    return used === proof.length ? node : null;
  }

  /** Mirrors Credits.verifySpentInclusion / verifySpentAbsence. */
  static verify(root: Hex, p: SpentProof): boolean {
    const eq = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();
    if (p.kind === "inclusion") {
      const t = SpentTree.treeRootFrom(spentLeaf(p.keyHash, p.cumulativeSpent), p.index, p.leafCount, p.proof);
      return t !== null && eq(spentCommitment(t, p.leafCount), root);
    }
    const k = BigInt(p.keyHash);
    if (p.gap < 0 || p.gap > p.leafCount) return false;
    if (p.gap > 0 && (!p.below || BigInt(p.below.keyHash) >= k)) return false;
    if (p.gap < p.leafCount && (!p.above || BigInt(p.above.keyHash) <= k)) return false;
    if (p.leafCount === 0) return eq(root, ZERO32);
    let tree: Hex | null = null;
    if (p.gap > 0) {
      tree = SpentTree.treeRootFrom(spentLeaf(p.below!.keyHash, p.below!.cumulativeSpent), p.gap - 1, p.leafCount, p.below!.proof);
      if (tree === null) return false;
    }
    if (p.gap < p.leafCount) {
      const t = SpentTree.treeRootFrom(spentLeaf(p.above!.keyHash, p.above!.cumulativeSpent), p.gap, p.leafCount, p.above!.proof);
      if (t === null || (tree !== null && t !== tree)) return false;
      tree = t;
    }
    return eq(spentCommitment(tree!, p.leafCount), root);
  }
}
