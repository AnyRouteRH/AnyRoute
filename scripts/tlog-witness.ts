#!/usr/bin/env bun
// A minimal witness for the Anyroute transparency log (src/tlog).
//
//   bun scripts/tlog-witness.ts keygen <name>   print a new witness signer key and the verifier key the log operator lists
//                                               in TLOG_WITNESSES (the signer key is secret: keep it with the witness)
//   bun scripts/tlog-witness.ts run [--once]    poll the log, cosign each checkpoint that is consistent with the last one
//                                               this witness cosigned, and hand the cosignature back to the log
//
// Environment for `run`:
//   TLOG_URL                  the router's base URL (checkpoint at <url>/tlog/checkpoint, JSON API at <url>/api/v1/tlog)
//   TLOG_LOG_KEY              the log's verifier key (<origin>+<id>+<key>), obtained out of band, never from the log itself
//   TLOG_WITNESS_KEY          this witness's signer key (PRIVATE+KEY+<name>+<id>+<key>, from `keygen`)
//   TLOG_WITNESS_STATE        file that keeps the newest cosigned checkpoint per log (default ./tlog-witness-state.json)
//   TLOG_WITNESS_INTERVAL_S   seconds between rounds (default 60)
//
// The witness refuses, and never cosigns, a checkpoint whose log signature does not verify, that is older than the one
// it cosigned, that has a different root at the same size (a fork), or whose consistency proof does not verify.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { formatSignerKey, noteSigner, parseSignerKey, parseVerifierKey, SIG_COSIGNATURE_V1, SIG_ED25519 } from "../src/tlog/note.ts";
import { Witness, type WitnessResult, type WitnessState, type WitnessStore } from "../src/tlog/witness.ts";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A witness whose signer key is the C2SP PRIVATE+KEY encoding; its cosignatures use the cosignature/v1 (0x04) key. */
export function witnessFromKeys(logKey: string, witnessKey: string, store: WitnessStore): Witness {
  const log = parseVerifierKey(logKey);
  if (log.type !== SIG_ED25519) throw new Error("TLOG_LOG_KEY must be the log's Ed25519 (0x01) verifier key");
  const { name, seed } = parseSignerKey(witnessKey);
  return new Witness(log, noteSigner(name, SIG_COSIGNATURE_V1, seed), store);
}

export function fileStore(path: string): WitnessStore {
  const read = (): Record<string, WitnessState> => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  return {
    load: (origin) => read()[origin] ?? null,
    save: (origin, state) => {
      const all = { ...read(), [origin]: state };
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/** One round: fetch the checkpoint, check it, and on success submit the cosignature. */
export async function witnessRound(baseUrl: string, witness: Witness, f: Fetch = fetch): Promise<WitnessResult & { submitted?: { status: number; body: unknown } }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await f(`${base}/tlog/checkpoint`, { headers: { accept: "text/plain" } });
  if (!res.ok) throw new Error(`GET /tlog/checkpoint failed with ${res.status}`);
  const note = await res.text();
  const result = await witness.process(note, async (from, to) => {
    const r = await f(`${base}/api/v1/tlog/consistency?from=${from}&to=${to}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`consistency proof request failed with ${r.status}`);
    const j = (await r.json()) as { data?: { proof?: unknown } };
    if (!Array.isArray(j.data?.proof) || j.data.proof.some((p) => typeof p !== "string")) throw new Error("malformed consistency proof");
    return (j.data.proof as string[]).map((p) => Buffer.from(p, "base64"));
  });
  if (!result.ok) return result;
  const sub = await f(`${base}/api/v1/tlog/cosignatures`, { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: result.note });
  return { ...result, submitted: { status: sub.status, body: await sub.json().catch(() => null) } };
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (cmd === "keygen") {
    const name = rest[0];
    if (!name) throw new Error("usage: tlog-witness.ts keygen <name>");
    const seed = randomBytes(32);
    const signer = noteSigner(name, SIG_COSIGNATURE_V1, seed);
    console.log(`signer key (secret):   ${formatSignerKey(name, seed)}`);
    console.log(`verifier key (public): ${signer.verifierKey}`);
    return;
  }
  if (cmd !== "run") throw new Error("usage: tlog-witness.ts keygen <name> | run [--once]");
  const need = (k: string) => process.env[k] || (() => { throw new Error(`${k} is required`); })();
  const witness = witnessFromKeys(need("TLOG_LOG_KEY"), need("TLOG_WITNESS_KEY"), fileStore(process.env.TLOG_WITNESS_STATE || "./tlog-witness-state.json"));
  const url = need("TLOG_URL");
  const interval = Math.max(5, Number(process.env.TLOG_WITNESS_INTERVAL_S || 60)) * 1000;
  for (;;) {
    try {
      const r = await witnessRound(url, witness);
      console.log(JSON.stringify(r.ok ? { at: new Date().toISOString(), ok: true, size: r.size, submitted: r.submitted?.status } : { at: new Date().toISOString(), ok: false, code: r.code, reason: r.reason }));
      if (!r.ok && (r.code === "fork" || r.code === "inconsistent")) process.exitCode = 2;
    } catch (e) {
      console.error(JSON.stringify({ at: new Date().toISOString(), error: (e as Error).message }));
    }
    if (rest.includes("--once")) return;
    await Bun.sleep(interval);
  }
}

if (import.meta.main) await main(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
