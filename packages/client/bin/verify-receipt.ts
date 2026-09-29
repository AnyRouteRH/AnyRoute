// Verify a receipt from the command line, v2 first when the receipt has one:
//   bun packages/client/bin/verify-receipt.ts <receipt id> [--base https://router.example] [--events stream.sse]
// Order: COSE signature (key from the router's published key set), then the chunk chain head when --events points at
// the raw SSE transcript of the streamed response, then the Merkle path from GET /api/v1/receipts/<id>/proof. The v1
// signature is checked too. Exits 0 only when every check that ran passed.
import { readFileSync } from "node:fs";
import { fetchReceiptKeys, verifyReceipt, verifyReceiptV2 } from "../src/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rid = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const base = (flag("--base") ?? process.env.ANYROUTE_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
if (!rid) {
  console.error("usage: bun packages/client/bin/verify-receipt.ts <receipt id> [--base URL] [--events stream.sse]");
  process.exit(2);
}

/** The data of every event before the receipt event, from a raw SSE transcript. */
function chunksOf(transcript: string): string[] {
  const out: string[] = [];
  for (const block of transcript.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    if (/"receipt"\s*:/.test(data) && JSON.parse(data).receipt) break;
    out.push(data);
  }
  return out;
}

const get = async (path: string) => {
  const r = await fetch(base + path, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`GET ${path} failed with ${r.status}`);
  return ((await r.json()) as { data: any }).data;
};

const keys = await fetchReceiptKeys(base);
const receipt = await get(`/api/v1/receipts/${encodeURIComponent(rid)}`);
const proof = await get(`/api/v1/receipts/${encodeURIComponent(rid)}/proof`);
const events = flag("--events");
const chunks = events ? chunksOf(readFileSync(events, "utf8")) : undefined;

let ok = true;
const print = (title: string, checks: { id: string; status: string; detail: string }[]) => {
  console.log(title);
  for (const c of checks) console.log(`  ${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP"}  ${c.id.padEnd(14)} ${c.detail}`);
};
if (receipt.v2?.cose) {
  const v2 = await verifyReceiptV2(receipt.v2.cose, { keys, chunks, proof: proof?.rooted && proof.leaf_version === 2 ? proof : null });
  print(`receipt v2 ${rid}`, v2.checks);
  if (proof?.rooted) console.log(`  root ${proof.root} ${proof.anchored ? `posted on chain (tx ${proof.tx})` : "kept off chain (not posted)"}`);
  ok &&= v2.valid;
} else console.log(`receipt ${rid} has no v2 encoding`);
const v1 = await verifyReceipt({ payload: receipt.payload, sig: receipt.sig, key_id: receipt.key_id, leaf: receipt.leaf, anchor: receipt.anchor }, { keys });
print(`receipt v1 ${rid}`, v1.checks);
ok &&= v1.valid;
console.log(ok ? "OK" : "NOT VERIFIED");
process.exit(ok ? 0 : 1);
