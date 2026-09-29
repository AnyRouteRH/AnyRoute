// Check one IPX oracle update the way a consumer must: digest, signature, signer, freshness, halt and THIN state.
// Read-only: it fetches one public URL (or reads a file) and sends nothing.
//
//   bun scripts/ipx-oracle-verify.ts --url https://<router>/api/v1/ipx/IPX-OPEN-70B/oracle --public-key <pinned key> [--max-age-s 900] [--json]
//   bun scripts/ipx-oracle-verify.ts --file response.json --public-key <pinned key>
//
// --public-key is the oracle key that was registered with the consumer, pinned out of band. Without it the script
// only proves the update matches the key it names, says so, and exits 1 unless --unpinned is given.
//
// Exit codes: 0 usable (normal or reduce_only), 1 not verified or unreadable, 2 verified but the consumer must halt
// (halted by the operator, past valid_until, or no update).
import { readFileSync } from "node:fs";
import { ORACLE_ALGORITHMS, verifyUpdate, type OracleAlgorithm } from "../src/services/ipx-oracle-sign.ts";

const USAGE = "usage: bun scripts/ipx-oracle-verify.ts (--url <https://.../api/v1/ipx/<class>/oracle> | --file <json>) --public-key <key> [--algorithm ed25519|secp256k1-eip191] [--max-age-s N] [--unpinned] [--json]";

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`Unexpected argument ${a}.\n${USAGE}`);
    const name = a.slice(2);
    if (["json", "help", "unpinned"].includes(name)) flags.set(name, true);
    else if (["url", "file", "public-key", "algorithm", "max-age-s"].includes(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value.\n${USAGE}`);
      flags.set(name, v);
    } else throw new Error(`Unknown flag --${name}.\n${USAGE}`);
  }
  return flags;
}

async function load(f: Map<string, string | true>): Promise<unknown> {
  const url = f.get("url");
  const file = f.get("file");
  if (typeof url === "string") {
    const u = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("--url must be https (http only for localhost).");
    const res = await fetch(u, { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`The endpoint answered HTTP ${res.status}.`);
    return res.json();
  }
  if (typeof file === "string") return JSON.parse(readFileSync(file, "utf8"));
  throw new Error(`Give --url or --file.\n${USAGE}`);
}

async function main() {
  const f = parseArgs(process.argv.slice(2));
  if (f.has("help")) return console.log(USAGE);
  const publicKey = typeof f.get("public-key") === "string" ? (f.get("public-key") as string) : undefined;
  if (!publicKey && !f.has("unpinned")) throw new Error(`--public-key is required (the key pinned when the oracle was registered), or pass --unpinned to check only self-consistency.\n${USAGE}`);
  const algorithm = f.get("algorithm");
  if (algorithm !== undefined && !ORACLE_ALGORITHMS.includes(algorithm as OracleAlgorithm)) throw new Error(`--algorithm must be one of ${ORACLE_ALGORITHMS.join(", ")}.`);
  const maxAge = f.get("max-age-s");
  if (typeof maxAge === "string" && !/^\d+$/.test(maxAge)) throw new Error("--max-age-s must be a whole number of seconds.");

  const doc = (await load(f)) as { data?: { update?: unknown; halted?: boolean; halt?: { reason?: string } | null } } & Record<string, unknown>;
  // The endpoint wraps the update; a bare update is accepted too.
  const wrapped = doc && typeof doc === "object" && doc.data && typeof doc.data === "object" ? doc.data : null;
  const update = wrapped ? wrapped.update : doc;
  const operatorHalt = !!wrapped && (wrapped.halted === true || !!wrapped.halt);

  const v = await verifyUpdate(update, {
    publicKey,
    algorithm: algorithm as OracleAlgorithm | undefined,
    maxAgeS: typeof maxAge === "string" ? Number(maxAge) : undefined,
  });
  const action = operatorHalt ? "halt" : v.assessment.consumer_action;
  const problems = operatorHalt ? [...v.problems, `the operator has halted this index${wrapped?.halt?.reason ? ` (${wrapped.halt.reason})` : ""}`] : v.problems;
  const verified = v.ok && (v.pinned || f.has("unpinned"));
  const out = { verified, pinned: v.pinned, signature_valid: v.signature_valid, digest_valid: v.digest_valid, status: operatorHalt ? "halted" : v.assessment.status, consumer_action: action, age_s: v.assessment.age_s, problems };

  if (f.has("json")) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`digest      ${v.digest_valid ? "ok" : "MISMATCH"}`);
    console.log(`signature   ${v.signature_valid ? "ok" : "INVALID"}${v.pinned ? " (against the pinned key)" : " (against the key the update names; not pinned)"}`);
    console.log(`status      ${out.status}${out.age_s === null ? "" : ` · age ${out.age_s}s`}`);
    console.log(`consumer    ${action === "normal" ? "may use the price" : action === "reduce_only" ? "reduce-only: the class is THIN" : "must halt"}`);
    for (const p of problems) console.log(`problem     ${p}`);
  }
  if (!verified) process.exit(1);
  process.exit(action === "halt" ? 2 : 0);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
