import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, policiesFor, policyState, verifyEventChain } from "../src/agents/store.ts";
import { verifyRecordCertificate } from "../packages/client/src/record-certificate.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";
import { noteSigner, SIG_COSIGNATURE_V1 } from "../src/tlog/note.ts";

let h: Harness;
beforeAll(async () => {
  const witness = noteSigner("combined-witness.example/log", SIG_COSIGNATURE_V1, randomBytes(32));
  h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true", TLOG_ENABLED: "true", TLOG_WITNESSES: witness.verifierKey, TLOG_WITNESS_QUORUM: "1" } });
  await h.ctx.tlog!.idle();
});
afterAll(async () => { await h?.close(); });

test("ledger receipts, autonomy, breaker kills and record certificates coexist", async () => {
  const key = await h.fundedKey();
  const path = `/api/v1/agents/${key.hash}`;
  const saved = await h.request(path + "/policy", { method: "PUT", headers: key.auth, json: {
    version: 1, models: {}, caps: {}, on_breach: "deny",
    breakers: { max_requests_per_minute: 2 },
    autonomy: { rungs: [{ after_days: 0, clean_requests: 1, caps_multiplier: 2 }], demote_on: ["breaker"] },
  } });
  expect(saved.status).toBe(200);
  const sha = (await saved.json()).data.sha256;
  const state = async () => policyState(h.ctx.db, (await policiesFor(h.ctx.db, key.hash))[0], new Date());
  const call = () => h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: {
    model: MODELS.llama.slug, messages: [{ role: "user", content: "combined ledger sentinel" }], max_tokens: 32,
  } });
  for (let i = 0; i < 2; i++) {
    const response = await call();
    expect(response.status).toBe(200);
    await response.text();
    expect((await state()).autonomy?.rung).toBe(1);
  }
  const denied = await call();
  expect(denied.status).toBe(403);
  expect((await denied.json()).error.type).toBe("agent_killed");
  const stopped = await state();
  expect(stopped.killed).toBe(true);
  expect(stopped.autonomy?.rung).toBe(0);

  const response = await h.request(path + "/ledger", { headers: key.auth });
  expect(response.status).toBe(200);
  const { data } = await response.json();
  expect(data.rows).toHaveLength(3);
  expect(data.rows.every((r: any) => r.policy_sha256 === sha && !r.unlinked)).toBe(true);
  const allowed = data.rows.filter((r: any) => r.decision === "allow");
  expect(allowed).toHaveLength(2);
  expect(allowed.every((r: any) => r.receipt_id && r.verify_url && r.event_ids.length === 1)).toBe(true);
  expect(data.rows.find((r: any) => r.decision === "deny")).toMatchObject({ cost_pico: "0", receipts: [] });
  expect(data.totals_per_day[0].requests).toBe(3);
  expect(JSON.stringify(data)).not.toContain("combined ledger sentinel");
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, key.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.filter(e => e.kind === "autonomy_clean")).toHaveLength(2);
  expect(events.filter(e => e.kind === "breaker")).toHaveLength(1);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);

  const issued = await h.request("/api/v1/agents/me/record-certificate", { method: "POST", headers: key.auth, json: { claims: ["requests_at_least:2"] } });
  expect(issued.status).toBe(200);
  const certificate = (await issued.json()).data;
  expect(await verifyRecordCertificate(certificate, { keys: await h.ctx.signer.jwks() })).toBe(true);
  const unproven = await h.request("/api/v1/agents/me/record-certificate", { method: "POST", headers: key.auth, json: { claims: ["requests_at_least:3"] } });
  expect(unproven.status).toBe(422);
});
