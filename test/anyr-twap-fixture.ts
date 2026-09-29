import { createPublicClient, custom, type PublicClient } from "viem";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

// Replays RPC responses recorded from the public Robinhood Chain RPC (scripts/capture-anyr-twap-fixture.ts) so the
// $ANYR price code runs on real pool state and swap history. A request the recording does not contain fails the test.
export type AnyrFixture = {
  meta: { capturedAt: string; chainId: number; poolManager: string; legs: unknown[]; windowSeconds: number; note: string };
  /** What the price code returned when it was recorded, with the deviation guard off. */
  reading: { spot: number; average: number; conservative: number; windowSeconds: number; block: number; swaps: number };
  calls: { method: string; params: unknown[]; result: unknown }[];
};

export function loadAnyrFixture(name: string) {
  const fixture = JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).toString()) as AnyrFixture;
  const byRequest = new Map(fixture.calls.map((c) => [`${c.method}${JSON.stringify(c.params)}`, c.result]));
  const requested: string[] = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        requested.push(method);
        const key = `${method}${JSON.stringify(params ?? [])}`;
        if (!byRequest.has(key)) throw new Error(`the recording has no response for ${key.slice(0, 200)}`);
        return byRequest.get(key);
      },
    }),
  }) as PublicClient;
  return { fixture, client, requested };
}
