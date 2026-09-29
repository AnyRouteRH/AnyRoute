import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { peekProviderCertificate, providerFetch } from "../src/providers/network.ts";

// A provider that goes down must fail its request, never crash the process: a refused connect can emit more than one
// error event, and an unhandled one takes the whole worker down (seen in production when an attested provider stopped).
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("provider connection failures", () => {
  test("refused connections reject cleanly on plain, pinned and certificate-peek paths", async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const port = await closedPort();
      const policy = { production: false, allowDevelopmentMockLoopback: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] } as const;
      const pin = { certPem: "-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n", spkiSha256: "0".repeat(64) };
      for (let i = 0; i < 3; i++) {
        await expect(providerFetch(`http://provider.test:${port}/v1/models`, { signal: AbortSignal.timeout(150) }, policy)).rejects.toThrow();
        await expect(providerFetch(`https://provider.test:${port}/v1/models`, { signal: AbortSignal.timeout(150) }, { ...policy, tlsPin: pin })).rejects.toThrow();
        await expect(peekProviderCertificate(`https://provider.test:${port}/attest`, policy, AbortSignal.timeout(150))).rejects.toThrow();
      }
      await Bun.sleep(400); // past every timeout: late error events must not escape
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
