import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { agentPolicySchema, type AgentPolicy } from "../src/agents/policy.ts";
import { agentPolicyEvents } from "../src/agents/schema.ts";
import { eventJson, policiesFor, policyState, verifyEventChain } from "../src/agents/store.ts";
import { holds, keys } from "../src/db/schema.ts";
import { reserve } from "../src/ledger/ledger.ts";
import { usdToPico } from "../src/lib/money.ts";
import { MODELS, startRouter, type Harness } from "./helpers.ts";

let h: Harness;
beforeAll(async () => { h = await startRouter({ env: { AGENT_POLICY_ENABLED: "true" } }); });
afterAll(async () => { await h?.close(); });

test("earned caps and breaker counters coexist; a trip kills and demotes breaker-only autonomy", async () => {
  const k = await h.fundedKey();
  const spec: AgentPolicy = {
    version: 1, models: {}, caps: { per_request_usd: 1 }, on_breach: "deny",
    breakers: { max_requests_per_minute: 2 },
    autonomy: { rungs: [{ after_days: 0, clean_requests: 1, caps_multiplier: 2 }], demote_on: ["breaker"] },
  };
  expect(agentPolicySchema.parse(spec)).toEqual(spec);
  const path = `/api/v1/agents/${k.hash}`;
  expect((await h.request(path + "/policy", { method: "PUT", headers: k.auth, json: spec })).status).toBe(200);
  const [key] = await h.ctx.db.select().from(keys).where(eq(keys.keyHash, k.hash));
  const admit = (amount: bigint) => reserve(h.ctx.db, {
    id: `combined-${crypto.randomUUID()}`, accountId: key.accountId, keyHash: k.hash, amount,
    agent: { models: [MODELS.llama.slug], lane: "public", max_output_tokens: 32, body: {} },
  });
  const state = async () => policyState(h.ctx.db, (await policiesFor(h.ctx.db, k.hash))[0], new Date());
  await admit(1n);
  expect((await state()).autonomy?.rung).toBe(1);
  expect((await state()).breakers?.requests_minute).toBe(1);
  await admit(usdToPico(1.5));
  expect((await state()).breakers?.requests_minute).toBe(2);
  await expect(admit(1n)).rejects.toMatchObject({ type: "agent_killed" });
  const stopped = await state();
  expect(stopped.killed).toBe(true);
  expect(stopped.autonomy?.rung).toBe(0);
  expect(stopped.autonomy?.clean_requests).toBe(0);
  expect(await h.ctx.db.select().from(holds).where(eq(holds.keyHash, k.hash))).toHaveLength(2);
  const events = await h.ctx.db.select().from(agentPolicyEvents).where(eq(agentPolicyEvents.keyHash, k.hash)).orderBy(asc(agentPolicyEvents.id));
  expect(events.filter(e => e.kind === "breaker")).toHaveLength(1);
  expect(events.filter(e => e.kind === "autonomy_clean")).toHaveLength(2);
  expect(verifyEventChain(events.map(eventJson))).toBe(true);
  expect((await h.request(path + "/resume", { method: "POST", headers: k.auth })).status).toBe(200);
  const resumed = await state();
  expect(resumed.killed).toBe(false);
  expect(resumed.breakers?.requests_minute).toBe(0);
  expect(resumed.autonomy?.rung).toBe(0);
  expect(resumed.spent_pico.hour).toBe(usdToPico(1.5) + 1n);
});
