import { describe, expect, test } from "bun:test";
import { createAttestationProvider } from "../src/attestation/index.ts";
import { DevAttestationProvider } from "../src/attestation/dev.ts";
import { DstackAttestationProvider, resolveDstackTarget } from "../src/attestation/dstack.ts";
import { TdxConfigfsProvider, type TsmFs } from "../src/attestation/tdx.ts";
import { parseTdxQuote } from "../src/attestation/tdx-quote.ts";
import { dstackProvider, fakeTdxQuote, mockDstackFetch } from "./helpers.ts";

const RD = "ab".repeat(64);
const rejectsWith = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return null;
};

describe("provider selection", () => {
  test("the dev provider is refused unless SIDECAR_DEV_ATTESTATION=true", () => {
    expect(() => createAttestationProvider({ provider: "dev" }, {})).toThrow(/SIDECAR_DEV_ATTESTATION/);
    expect(() => createAttestationProvider({ provider: "dev" }, { SIDECAR_DEV_ATTESTATION: "1" })).toThrow();
    expect(() => createAttestationProvider({ provider: "dev" }, { SIDECAR_DEV_ATTESTATION: "false" })).toThrow();
    expect(createAttestationProvider({ provider: "dev" }, { SIDECAR_DEV_ATTESTATION: "true" }).kind).toBe("dev");
  });

  test("hardware providers do not need the flag", () => {
    expect(createAttestationProvider({ provider: "dstack", dstackEndpoint: "http://dstack.test" }, {}).kind).toBe("dstack");
    expect(createAttestationProvider({ provider: "tdx" }, {}).kind).toBe("tdx");
  });
});

describe("dev provider", () => {
  test("marks its evidence as simulated everywhere it can", async () => {
    const e = await new DevAttestationProvider().quote(Buffer.from(RD, "hex"));
    expect(e.dev).toBe(true);
    expect(e.kind).toBe("dev");
    expect(e.format).toBe("dev-simulated");
    expect(e.measurements.simulated).toBe("true");
    expect(Buffer.from(e.quote, "hex").toString()).toStartWith("dev-simulated:");
    expect(e.reportData).toBe(RD);
  });
});

describe("TDX quote reader", () => {
  test("reads report data and registers, refuses other versions and tee types", () => {
    const f = parseTdxQuote(fakeTdxQuote(RD));
    expect(f.reportData).toBe(RD);
    expect(f.mrtd).toBe("a1".repeat(48));
    expect(() => parseTdxQuote(fakeTdxQuote(RD, { version: 5 }))).toThrow(/version/);
    expect(() => parseTdxQuote(fakeTdxQuote(RD, { teeType: 0 }))).toThrow(/not a TDX/);
    expect(() => parseTdxQuote(Buffer.alloc(10))).toThrow(/too short/);
  });
});

describe("dstack provider", () => {
  test("returns a quote bound to the requested report data and reports the compose hash", async () => {
    const p = dstackProvider({ composeHash: `sha256:${"cd".repeat(32)}` });
    const info = await p.platformInfo();
    expect(info.composeHash).toBe(`sha256:${"cd".repeat(32)}`);
    expect(info.appId).toBe("app123");
    const q = await p.quote(Buffer.from(RD, "hex"));
    expect(q.dev).toBe(false);
    expect(q.kind).toBe("dstack");
    expect(q.reportData).toBe(RD);
    expect(q.measurements.mrtd).toBe("a1".repeat(48));
    expect(q.eventLog).toContain("compose-hash");
  });

  test("falls back to the older tappd paths on 404", async () => {
    const p = new DstackAttestationProvider({ endpoint: "http://dstack.test", fetchImpl: mockDstackFetch({ tappd: true, composeHash: "cd".repeat(32) }) });
    expect((await p.platformInfo()).composeHash).toBe(`sha256:${"cd".repeat(32)}`);
    expect((await p.quote(Buffer.from(RD, "hex"))).reportData).toBe(RD);
  });

  test("refuses a quote whose report data is not the value asked for", async () => {
    const p = new DstackAttestationProvider({ endpoint: "http://dstack.test", fetchImpl: mockDstackFetch({ badReportData: true }) });
    expect(await rejectsWith(p.quote(Buffer.from(RD, "hex")))).toBe("QUOTE_REPORT_DATA_MISMATCH");
  });

  test("reports an unreachable agent and a missing socket", async () => {
    const down = new DstackAttestationProvider({
      endpoint: "http://dstack.test",
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await rejectsWith(down.quote(Buffer.from(RD, "hex")))).toBe("DSTACK_UNAVAILABLE");
    expect(() => resolveDstackTarget(undefined, () => false)).toThrow(/no dstack guest agent socket/);
    expect(resolveDstackTarget(undefined, (p) => p === "/var/run/tappd.sock")).toEqual({ kind: "unix", path: "/var/run/tappd.sock" });
    expect(resolveDstackTarget("unix:/run/x.sock", () => false)).toEqual({ kind: "unix", path: "/run/x.sock" });
  });

  test("rejects a response with no quote", async () => {
    const p = new DstackAttestationProvider({ endpoint: "http://dstack.test", fetchImpl: (async () => Response.json({ quote: "" })) as unknown as typeof fetch });
    expect(await rejectsWith(p.quote(Buffer.from(RD, "hex")))).toBe("DSTACK_BAD_RESPONSE");
  });
});

describe("tdx configfs-tsm provider", () => {
  function fakeFs(opts: { provider?: string; quote?: Buffer; changeGeneration?: boolean; mkdirFails?: boolean } = {}) {
    const files = new Map<string, Buffer>();
    const calls: string[] = [];
    let gen = 1;
    const fs: TsmFs = {
      mkdir: (p) => {
        calls.push(`mkdir ${p}`);
        if (opts.mkdirFails) throw new Error("EACCES");
      },
      rmdir: (p) => void calls.push(`rmdir ${p}`),
      write: (p, d) => void files.set(p, Buffer.from(d)),
      read: (p) => {
        if (p.endsWith("/provider")) return Buffer.from(`${opts.provider ?? "tdx_guest"}\n`);
        if (p.endsWith("/generation")) return Buffer.from(String(gen));
        if (p.endsWith("/outblob")) {
          if (opts.changeGeneration) gen++;
          const inblob = files.get(p.replace("outblob", "inblob"))!;
          return opts.quote ?? fakeTdxQuote(inblob.toString("hex"));
        }
        throw new Error("ENOENT");
      },
    };
    return { fs, calls, files };
  }

  test("writes the report data to inblob, reads the quote and cleans up", async () => {
    const { fs, calls, files } = fakeFs();
    const q = await new TdxConfigfsProvider("/sys/kernel/config/tsm/report", fs).quote(Buffer.from(RD, "hex"));
    expect(q.kind).toBe("tdx");
    expect(q.dev).toBe(false);
    expect(q.reportData).toBe(RD);
    expect([...files.entries()][0][1].toString("hex")).toBe(RD);
    expect(calls[0]).toStartWith("mkdir /sys/kernel/config/tsm/report/anyroute-");
    expect(calls[calls.length - 1]).toStartWith("rmdir ");
  });

  test("refuses other TSM providers, races, a mismatched quote and bad input", async () => {
    expect(await rejectsWith(new TdxConfigfsProvider("/x", fakeFs({ provider: "sev_guest" }).fs).quote(Buffer.from(RD, "hex")))).toBe("TDX_UNAVAILABLE");
    expect(await rejectsWith(new TdxConfigfsProvider("/x", fakeFs({ changeGeneration: true }).fs).quote(Buffer.from(RD, "hex")))).toBe("TDX_RACE");
    expect(await rejectsWith(new TdxConfigfsProvider("/x", fakeFs({ quote: fakeTdxQuote("00".repeat(64)) }).fs).quote(Buffer.from(RD, "hex")))).toBe("QUOTE_REPORT_DATA_MISMATCH");
    expect(await rejectsWith(new TdxConfigfsProvider("/x", fakeFs({ mkdirFails: true }).fs).quote(Buffer.from(RD, "hex")))).toBe("TDX_UNAVAILABLE");
    expect(await rejectsWith(new TdxConfigfsProvider("/x", fakeFs().fs).quote(new Uint8Array(10)))).toBe("QUOTE_BAD_INPUT");
  });
});
