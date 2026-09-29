// ECDSA P-256 verification over a bare digest, written from the textbook definition with BigInt. It exists so a test can
// check what Sigstore Rekor checks for a hashedrekord entry (a DER signature against the artifact's hash) without leaning on
// the implementation that made the signature.

const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const a = p - 3n;
const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: Point = { x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n };
type Point = { x: bigint; y: bigint } | null;

const mod = (v: bigint, m = p) => ((v % m) + m) % m;
function inv(v: bigint, m: bigint): bigint {
  let [r0, r1, t0, t1] = [m, mod(v, m), 0n, 1n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  return mod(t0, m);
}
function add(P: Point, Q: Point): Point {
  if (!P) return Q;
  if (!Q) return P;
  if (P.x === Q.x && mod(P.y + Q.y) === 0n) return null;
  const l = P.x === Q.x ? mod((3n * P.x * P.x + a) * inv(2n * P.y, p)) : mod((Q.y - P.y) * inv(Q.x - P.x, p));
  const x = mod(l * l - P.x - Q.x);
  return { x, y: mod(l * (P.x - x) - P.y) };
}
function mul(k: bigint, P: Point): Point {
  let R: Point = null;
  for (let Q = P; k > 0n; k >>= 1n, Q = add(Q, Q)) if (k & 1n) R = add(R, Q);
  return R;
}
const big = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));

function readDer(sig: Buffer): [bigint, bigint] {
  if (sig[0] !== 0x30) throw new Error("not a DER sequence");
  let i = 2;
  const int = () => {
    if (sig[i] !== 0x02) throw new Error("not a DER integer");
    const len = sig[i + 1]!;
    const v = big(sig.subarray(i + 2, i + 2 + len));
    i += 2 + len;
    return v;
  };
  return [int(), int()];
}

/** `spki` is a SubjectPublicKeyInfo DER for a P-256 key; `digest` the 32-byte hash that was signed. */
export function verifyEcdsaDigest(derSig: Buffer, digest: Buffer, spki: Buffer): boolean {
  const point = spki.subarray(-65);
  if (point[0] !== 4) throw new Error("expected an uncompressed point");
  const Q: Point = { x: big(point.subarray(1, 33)), y: big(point.subarray(33)) };
  const [r, s] = readDer(derSig);
  if (r <= 0n || r >= n || s <= 0n || s >= n) return false;
  const w = inv(s, n);
  const R = add(mul(mod(big(digest), n) * w % n, G), mul(r * w % n, Q));
  return !!R && mod(R.x, n) === r;
}
