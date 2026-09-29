import { SidecarError } from "../util.ts";

// Minimal reader for an Intel TDX v4 quote: header (48 bytes) followed by the TD report body (584 bytes).
// Body offsets: MRTD 136, RTMR0..3 328/376/424/472, REPORTDATA 520 (48/48/48/48/48/64 bytes).
// This reads fields; it does not verify the quote signature or certificate chain. That is a verifier's job.

export type TdxFields = { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string; rtmr3: string; reportData: string };

const HEADER = 48;
const BODY = 584;

export function parseTdxQuote(quote: Uint8Array): TdxFields {
  const b = Buffer.from(quote);
  if (b.length < HEADER + BODY) throw new SidecarError("QUOTE_MALFORMED", `TDX quote too short (${b.length} bytes)`);
  const version = b.readUInt16LE(0);
  if (version !== 4) throw new SidecarError("QUOTE_UNSUPPORTED", `unsupported TDX quote version ${version} (this sidecar reads version 4)`);
  const teeType = b.readUInt32LE(4);
  if (teeType !== 0x81) throw new SidecarError("QUOTE_UNSUPPORTED", `quote is not a TDX quote (tee type 0x${teeType.toString(16)})`);
  const at = (off: number, len: number) => b.subarray(HEADER + off, HEADER + off + len).toString("hex");
  return { mrtd: at(136, 48), rtmr0: at(328, 48), rtmr1: at(376, 48), rtmr2: at(424, 48), rtmr3: at(472, 48), reportData: at(520, 64) };
}

/** Confirm a hardware quote carries the report data we asked for, and return its registers. */
export function readBoundQuote(quote: Uint8Array, expectedReportDataHex: string): Record<string, string> {
  const f = parseTdxQuote(quote);
  if (f.reportData !== expectedReportDataHex.toLowerCase()) {
    throw new SidecarError("QUOTE_REPORT_DATA_MISMATCH", "the platform returned a quote whose report_data is not the value the sidecar asked it to bind");
  }
  return { mrtd: f.mrtd, rtmr0: f.rtmr0, rtmr1: f.rtmr1, rtmr2: f.rtmr2, rtmr3: f.rtmr3 };
}
