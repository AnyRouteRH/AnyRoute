import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { eq } from "drizzle-orm";
import { kv } from "../src/db/schema.ts";
import { startRouter, type Harness } from "./helpers.ts";

describe("wallet login and cache policy isolation", () => {
  let h: Harness;
  beforeAll(async () => { h = await startRouter(); });
  afterAll(async () => { await h.close(); });
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
