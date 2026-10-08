// D142: strip metadata from a JPEG without decoding it. The image data (SOF, DHT, DQT, DRI, SOS and the entropy-coded
// scans) is copied byte for byte; APP segments (EXIF, XMP, ICC, JFIF/JFXX thumbnails), comments and anything after EOI are
// dropped, except APP14 (Adobe), which tells decoders how to read the colour channels. Linear in the input size, no
// pixel buffers, no native code. Anything that isn't a well-formed JPEG within the limits fails closed before inference.
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const bad = () => new Error("This photo could not be prepared. Send it again as a JPEG photo.");

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const isApp = (m: number) => m >= 0xe0 && m <= 0xef;
const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;

export function reencodePhotoJpeg(input: Uint8Array): Uint8Array {
  if (!input.length || input.length > MAX_PHOTO_BYTES) throw bad();
  if (input[0] !== 0xff || input[1] !== 0xd8) throw bad();
  const out: Uint8Array[] = [Uint8Array.of(0xff, 0xd8)];
  let p = 2, frame = false, scans = 0;
  for (;;) {
    // Markers may be padded with extra 0xFF bytes.
    if (p >= input.length || input[p] !== 0xff) throw bad();
    while (p < input.length && input[p] === 0xff) p++;
    if (p >= input.length) throw bad();
    const marker = input[p++];
    if (marker === 0xd9) { // EOI: done; trailing bytes are dropped.
      if (!frame || !scans) throw bad();
      out.push(Uint8Array.of(0xff, 0xd9));
      break;
    }
    if (marker === 0xd8 || marker === 0x01 || isRst(marker)) throw bad();
    if (p + 2 > input.length) throw bad();
    const length = (input[p] << 8) | input[p + 1];
    if (length < 2 || p + length > input.length) throw bad();
    const segment = input.subarray(p - 2, p + length);
    p += length;
    if (SOF.has(marker)) {
      if (frame || length < 8) throw bad();
      const height = (segment[5] << 8) | segment[6], width = (segment[7] << 8) | segment[8];
      if (!height || !width || height * width > MAX_PIXELS) throw bad();
      frame = true;
    }
    if ((isApp(marker) && marker !== 0xee) || marker === 0xfe) continue; // metadata and comments
    out.push(segment);
    if (marker !== 0xda) continue;
    if (!frame) throw bad();
    scans++;
    // Entropy-coded data runs until the next marker that isn't a stuffed 0x00 or a restart marker.
    const start = p;
    while (p < input.length - 1 && !(input[p] === 0xff && input[p + 1] !== 0x00 && !isRst(input[p + 1]))) p++;
    if (p >= input.length - 1) throw bad();
    out.push(input.subarray(start, p));
  }
  const total = out.reduce((n, part) => n + part.length, 0), result = new Uint8Array(total);
  let at = 0;
  for (const part of out) { result.set(part, at); at += part.length; }
  return result;
}
