import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { bytesToHex, randomHex, SidecarError } from "../util.ts";
import type { AttestationProvider, PlatformInfo, QuoteEvidence } from "./types.ts";
import { readBoundQuote } from "./tdx-quote.ts";

// Quote generation through the kernel's configfs-tsm interface (Linux 6.7+, `tdx_guest` driver):
//   mkdir /sys/kernel/config/tsm/report/<name>
//   write 64 bytes to <name>/inblob         (the report data)
//   read  <name>/outblob                    (the quote; reading triggers generation)
//   read  <name>/provider                   ("tdx_guest" on Intel TDX)
//   read  <name>/generation                 (changes if something else touched the entry)
// Creating the directory needs privileges (typically root), so run the container as root for this provider.

export interface TsmFs {
  mkdir(path: string): void;
  rmdir(path: string): void;
  write(path: string, data: Uint8Array): void;
  read(path: string): Buffer;
}

export const nodeTsmFs: TsmFs = {
  mkdir: (p) => mkdirSync(p),
  rmdir: (p) => rmdirSync(p),
  write: (p, d) => writeFileSync(p, d),
  read: (p) => readFileSync(p),
};

export const DEFAULT_TSM_PATH = "/sys/kernel/config/tsm/report";

export class TdxConfigfsProvider implements AttestationProvider {
  readonly kind = "tdx" as const;
  constructor(
    private basePath: string = DEFAULT_TSM_PATH,
    private fs: TsmFs = nodeTsmFs,
  ) {}

  async platformInfo(): Promise<PlatformInfo> {
    return {}; // bare-metal TDX has no platform-reported compose hash; the operator supplies the compose file or hash
  }

  private optionalText(path: string): string | null {
    try {
      return this.fs.read(path).toString("utf8").trim();
    } catch {
      return null;
    }
  }

  async quote(reportData: Uint8Array): Promise<QuoteEvidence> {
    if (reportData.length !== 64) throw new SidecarError("QUOTE_BAD_INPUT", "report data must be 64 bytes");
    const dir = `${this.basePath}/anyroute-${randomHex(6)}`;
    try {
      this.fs.mkdir(dir);
    } catch (e) {
      throw new SidecarError("TDX_UNAVAILABLE", `cannot create a configfs-tsm report entry at ${dir}: ${(e as Error).message}`);
    }
    let out: Buffer;
    try {
      this.fs.write(`${dir}/inblob`, reportData);
      const provider = this.optionalText(`${dir}/provider`);
      if (provider !== "tdx_guest") throw new SidecarError("TDX_UNAVAILABLE", `configfs-tsm provider is "${provider ?? "unknown"}", not "tdx_guest" (this sidecar supports Intel TDX only)`);
      const genBefore = this.optionalText(`${dir}/generation`);
      out = this.fs.read(`${dir}/outblob`);
      const genAfter = this.optionalText(`${dir}/generation`);
      if (genBefore !== genAfter) throw new SidecarError("TDX_RACE", "the configfs-tsm report entry changed while the quote was generated");
    } catch (e) {
      if (e instanceof SidecarError) throw e;
      throw new SidecarError("TDX_UNAVAILABLE", `configfs-tsm quote generation failed: ${(e as Error).message}`);
    } finally {
      try {
        this.fs.rmdir(dir);
      } catch {
        /* best effort */
      }
    }
    if (!out.length) throw new SidecarError("TDX_UNAVAILABLE", "configfs-tsm returned an empty quote");
    const rd = bytesToHex(reportData);
    const measurements = readBoundQuote(out, rd);
    return {
      kind: "tdx",
      dev: false,
      format: "tdx-quote-v4",
      quote: out.toString("hex"),
      reportData: rd,
      eventLog: null,
      measurements,
      generatedAt: new Date().toISOString(),
    };
  }
}
