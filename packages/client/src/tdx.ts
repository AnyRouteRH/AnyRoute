import { bytesToHex } from "./bytes.js";

// Reader for an Intel TDX version 4 quote: a 48-byte header followed by the 584-byte TD report body.
// Body offsets: MRTD 136, RTMR0..3 328/376/424/472, REPORTDATA 520 (48/48/48/48/48/64 bytes).
// It reads fields; it does not check the quote signature or its certificate chain.

export type TdxFields = { version: number; teeType: number; mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

const HEADER = 48;
const BODY = 584;

export function parseTdxQuote(quote: Uint8Array): TdxFields {
  if (quote.length < HEADER + BODY) throw new Error(`TDX quote too short (${quote.length} bytes)`);
  const view = new DataView(quote.buffer, quote.byteOffset, quote.byteLength);
  const version = view.getUint16(0, true);
  if (version !== 4) throw new Error(`unsupported TDX quote version ${version} (this reader handles version 4)`);
  const teeType = view.getUint32(4, true);
  if (teeType !== 0x81) throw new Error(`not a TDX quote (tee type 0x${teeType.toString(16)})`);
  const at = (off: number, len: number) => bytesToHex(quote.subarray(HEADER + off, HEADER + off + len));
  return { version, teeType, mrtd: at(136, 48), rtmr0: at(328, 48), rtmr1: at(376, 48), rtmr2: at(424, 48), rtmr3: at(472, 48), reportData: at(520, 64) };
}
