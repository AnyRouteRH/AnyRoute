import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { eq } from "drizzle-orm";
import { kv } from "../src/db/schema.ts";
import { startRouter, type Harness } from "./helpers.ts";

describe("wallet login and cache policy isolation", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h.close(); });
  const wallet = privateKeyToAccount(generatePrivateKey());
  async function challenge() { return (await (await h.request("/api/v1/auth/wallet/challenge", { method: "POST", json: { address: wallet.address } })).json()).data; }
  test("one challenge creates exactly one key across concurrent requests; replay stays rejected", async () => {
    const c = await challenge();
    expect(c.message).toContain(`Chain ID: ${h.ctx.cfg.chain.id}`);
    expect(c.message).toContain(`Origin: ${new URL(h.ctx.cfg.publicUrl).origin}`);
    const json = { address: wallet.address, nonce: c.nonce, signature: await wallet.signMessage({ message: c.message }) };
    const responses = await Promise.all(Array.from({ length: 4 }, () => h.request("/api/v1/auth/wallet", { method: "POST", json })));
    expect(responses.map((r) => r.status).sort()).toEqual([201, 401, 401, 401]);
    expect((await h.request("/api/v1/auth/wallet", { method: "POST", json })).status).toBe(401);
  });
  test("wrong signatures and expired challenges fail without issuing a key", async () => {
    const c = await challenge();
    const wrong = await wallet.signMessage({ message: c.message + " different action" });
    expect((await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: c.nonce, signature: wrong } })).status).toBe(401);
    const [row] = await h.ctx.db.select().from(kv).where(eq(kv.key, `wallet-login:${c.nonce}`));
    await h.ctx.db.update(kv).set({ value: { ...row.value as object, expires: Date.now() - 1 } }).where(eq(kv.key, row.key));
    expect((await h.request("/api/v1/auth/wallet", { method: "POST", json: { address: wallet.address, nonce: c.nonce, signature: await wallet.signMessage({ message: c.message }) } })).status).toBe(401);
  });
  test("output redaction cannot be bypassed through streaming or legacy completions", async () => {
    const key = await h.fundedKey();
    await h.request(`/api/v1/keys/${key.hash}`, { method: "PATCH", headers: key.auth, json: { guardrails: { redact_output: true } } });
    const streamed = await h.request("/api/v1/chat/completions", { method: "POST", headers: key.auth, json: { model: "meta-llama/llama-3.3-70b-instruct", stream: true, messages: [{ role: "user", content: "person@example.test" }], guardrails: {} } });
    expect(streamed.status).toBe(400);
    const legacy = await h.request("/api/v1/completions", { method: "POST", headers: key.auth, json: { model: "meta-llama/llama-3.3-70b-instruct", prompt: "person@example.test", guardrails: {} } });
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).choices[0].text).not.toContain("person@example.test");
  });
  for (const mode of ["exact", "semantic"]) test(`${mode} cache cannot share unredacted output across keys or policy changes`, async () => {
    const root = await h.fundedKey();
    const body = { model: "meta-llama/llama-3.3-70b-instruct", provider: { only: ["alpha"] }, messages: [{ role: "user", content: "contact person@example.test" }], cache: { mode } };
    const chat = async (auth: Record<string, string>) => (await (await h.request("/api/v1/chat/completions", { method: "POST", headers: auth, json: body })).json());
    expect((await chat(root.auth)).choices[0].message.content).toContain("person@example.test");
    expect((await chat(root.auth)).cached).toBe(true);
    const child = await (await h.request("/api/v1/keys", { method: "POST", headers: root.auth, json: { guardrails: { redact_output: true } } })).json();
    const auth = { authorization: `Bearer ${child.key}` };
    const first = await chat(auth);
    expect(first.cached).not.toBe(true);
    expect(first.choices[0].message.content).toContain("[REDACTED_EMAIL]");
    const cached = await chat(auth);
    expect(cached.cached).toBe(true);
    expect(cached.choices[0].message.content).not.toContain("person@example.test");
    await h.request(`/api/v1/keys/${root.hash}`, { method: "PATCH", headers: root.auth, json: { guardrails: { redact_output: true } } });
    expect((await chat(root.auth)).choices[0].message.content).not.toContain("person@example.test");
  });
});
