// A small QR Code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1 to 10 (up to 213 bytes).
// It exists so the dashboard can show the escrow address as a scannable code without a dependency or a network
// request: the text never leaves the page. `qrMatrix(text)` returns the modules; `qrPath(matrix)` an SVG path.

// Level M block layout per version: error-correction codewords per block, then [blocks, data codewords per block] groups.
const M_BLOCKS = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGNMENT = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MAX_VERSION = 10;

const dataCodewords = (version) => M_BLOCKS[version].slice(1).reduce((n, [blocks, size]) => n + blocks * size, 0);
/** How many bytes of text fit at level M in `version`. */
export const capacity = (version) => dataCodewords(version) - (version < 10 ? 2 : 3);

// ---- Reed-Solomon over GF(256) (x^8 + x^4 + x^3 + x^2 + 1) ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function generator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

function remainder(data, degree) {
  const g = generator(degree);
  const out = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ out.shift();
    out.push(0);
    for (let i = 0; i < degree; i++) out[i] ^= mul(g[i + 1], factor);
  }
  return out;
}

// ---- message ----
function codewords(bytes, version) {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const total = dataCodewords(version) * 8;
  put(0, Math.min(4, total - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < total / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecc, ...groups] = M_BLOCKS[version];
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups)
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      blocks.push({ data: block, ecc: remainder(block, ecc) });
    }
  const out = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.data.length)); i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecc; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

// ---- matrix ----
const bit = (value, i) => ((value >>> i) & 1) === 1;

function frame(version) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const at = ALIGNMENT[version];
  for (const cy of at)
    for (const cx of at) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === at[at.length - 1]) || (cx === at[at.length - 1] && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  return { size, modules, fixed, set };
}

/** The 15 format bits: level M (00), the mask, BCH-protected, XOR 0x5412. */
export function formatBits(mask) {
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((mask << 10) | rem) ^ 0x5412;
}

function drawFormat({ size, set }, mask) {
  const bits = formatBits(mask);
  for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
  set(8, 7, bit(bits, 6));
  set(8, 8, bit(bits, 7));
  set(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
  set(8, size - 8, true);
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m) {
  const size = m.length;
  let score = 0;
  const lines = [...m, ...m.map((_, x) => m.map((row) => row[x]))];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    // The 1:1:3:1:1 finder shape with four light modules on one side.
    for (let i = 0; i + 11 <= size; i++) {
      const w = line.slice(i, i + 11).map(Number).join("");
      if (w === "10111010000" || w === "00001011101") score += 40;
    }
  }
  for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
  score += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
  return score;
}

/** Encode `text` (UTF-8) as a QR code: `{ version, size, modules }`, modules[y][x] true for dark. Throws when it does not fit version 10. */
export function qrMatrix(text, { mask: forced } = {}) {
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let version = 1;
  while (version <= MAX_VERSION && bytes.length > capacity(version)) version++;
  if (version > MAX_VERSION) throw new Error(`Too long for a QR code (${bytes.length} bytes; the limit is ${capacity(MAX_VERSION)}).`);
  const data = codewords(bytes, version);
  let best = null;
  for (let mask = forced ?? 0; mask < (forced === undefined ? 8 : forced + 1); mask++) {
    const f = frame(version);
    drawFormat(f, mask); // reserves the format areas so no data lands there
    let i = 0;
    for (let right = f.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < f.size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? f.size - 1 - vert : vert;
          if (!f.fixed[y][x]) {
            let dark = i < data.length * 8 && bit(data[i >>> 3], 7 - (i & 7));
            if (MASKS[mask](x, y)) dark = !dark;
            f.modules[y][x] = dark;
            i++;
          }
        }
    }
    drawFormat(f, mask);
    const score = penalty(f.modules);
    if (!best || score < best.score) best = { score, modules: f.modules, size: f.size };
  }
  return { version, size: best.size, modules: best.modules };
}

/** One SVG path covering every dark module of the matrix (viewBox `0 0 size size`), rows merged into runs. */
export function qrPath(matrix) {
  let d = "";
  matrix.modules.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      d += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return d;
}
