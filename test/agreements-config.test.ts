import { randomBytes } from "node:crypto";
import { formatSignerKey, noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";
import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const address = "0x" + "1".repeat(40);
const production = {
  NODE_ENV: "production", ANYROUTE_ENV: "production", RUNTIME_ROLE: "api", AUTO_MIGRATE: "false",
  HOST: "0.0.0.0", APP_SECRET: "fixture-".repeat(6), ADMIN_TOKEN: "fixture-admin-".repeat(3),
  PUBLIC_BASE_URL: "https://router.example", DATABASE_URL: "postgres://fixture:fixture-only-credential@localhost/test",
  REDIS_URL: "redis://:fixture-only-credential@localhost:6379", CREDITS_ADDRESS: address, CALLPAY_ADDRESS: address,
  PROVIDER_BOND_ADDRESS: address, RECEIPT_ANCHOR_ADDRESS: address, ROUTER_PRIVATE_KEY: "0x" + "3".repeat(64),
};

test("agreements default off and the real production loader accepts explicit opt-in", () => {
  expect(loadConfig({ ...production, AGENT_AGREEMENTS_ENABLED: undefined }).agreements.enabled).toBe(false);
  expect(loadConfig({ ...production, AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: address, DISPUTE_ORACLE_ADDRESS: "0x" + "2".repeat(40) }).agreements.enabled).toBe(true);
  expect(loadConfig({ ...production, AGENT_AGREEMENTS_ENABLED: "false" }).agreements.enabled).toBe(false);
  // Existing production dependency guards remain required with the flag on.
  expect(() => loadConfig({ ...production, AGENT_AGREEMENTS_ENABLED: "true", AGREEMENT_ESCROW_ADDRESS: address, DISPUTE_ORACLE_ADDRESS: "0x" + "2".repeat(40), REDIS_URL: "" })).toThrow();
});

test("production loader starts with isolated jury posting on and rejects incomplete or mixed signing roles", () => {
  const key = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const witness = noteSigner("witness.example/w", SIG_COSIGNATURE_V1, randomBytes(32));
  const env = { ...production, ROUTER_PRIVATE_KEY: undefined, RUNTIME_ROLE: "worker", WORKER_JOBS: "agreement-jury", AGENT_AGREEMENTS_ENABLED: true, AGREEMENT_ESCROW_ADDRESS: address, DISPUTE_ORACLE_ADDRESS: "0x" + "2".repeat(40), AGENT_AGREEMENTS_RULINGS_ENABLED: true, AGREEMENT_JURY_SIGNER_KEYS: [key(3), key(4), key(5)].join(","), AGREEMENT_JURY_API_KEY: "fixture-funded-key", TLOG_ENABLED: true, TLOG_SIGNING_KEY: formatSignerKey("router.example/tlog", randomBytes(32)), TLOG_WITNESS_QUORUM: 1, TLOG_WITNESSES: witness.verifierKey };
  expect(loadConfig(env).agreements.rulings).toBe(true);
  expect(loadConfig(env).agreements.signerKeys).toHaveLength(3);
  expect(() => loadConfig({ ...env, ROUTER_PRIVATE_KEY: key(6) })).toThrow("isolated");
  expect(() => loadConfig({ ...env, WORKER_JOBS: "agreement-jury,agreement-indexer" })).toThrow("isolated");
  expect(() => loadConfig({ ...env, AGREEMENT_JURY_SIGNER_KEYS: key(3) })).toThrow("one distinct key per model");
  expect(() => loadConfig({ ...env, AGREEMENT_JURY_SIGNER_KEYS: undefined })).toThrow();
});

test("jury abstentions, missing receipts and exact-bps disagreements never manufacture a majority", async () => {
  const { juryConsensus, evidenceRoot } = await import("../src/agreements/jury.ts");
  const vote = (model: string, payee_bps: number, verdict: "pay" | "refund" | "split" | "abstain") => ({ model, verdict: { verdict, payee_bps, reason: "Fixture" }, receipt_id: model, receipt_url: null, policy_hash: null, failure: null });
  expect(juryConsensus([vote("a", 10000, "pay"), vote("b", 10000, "pay"), vote("c", 0, "refund")], 2).tally_bitmap).toBe("3");
  expect(juryConsensus([vote("a", 4000, "split"), vote("b", 5000, "split"), vote("c", 0, "abstain")], 2).status).toBe("panel");
  expect(juryConsensus([vote("a", 0, "abstain"), vote("b", 0, "abstain"), vote("c", 10000, "pay")], 2).status).toBe("panel");
  expect(juryConsensus([{ ...vote("a", 10000, "pay"), receipt_id: null }, vote("b", 10000, "pay"), vote("c", 0, "refund")], 2).status).toBe("panel");
  expect(() => juryConsensus([vote("a", 10000, "pay"), vote("a", 10000, "pay"), vote("b", 0, "refund")], 2)).toThrow("distinct");
  expect(evidenceRoot([{ a: 1, b: 2 }])).toBe(evidenceRoot([{ b: 2, a: 1 }]));
});
