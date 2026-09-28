import { expect, test } from "bun:test";
import { normalizePerMillionCatalogue } from "../src/providers/per-million.ts";
import { parseProviderModels } from "../src/services/registry.ts";
import { usdToPico, tokenCost } from "../src/lib/money.ts";
import { openDatabase } from "../src/db/client.ts";
import { offers, providers } from "../src/db/schema.ts";
import { syncProvider } from "../src/services/registry.ts";

const model = {
  id: "openai/gpt-4o-mini", type: "chat", name: "GPT-4o-mini", privacyLevel: "anon",
  context_length: 128000, created_at: 1721260800000,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "temperature"],
  pricing: { type: "per_token", currency: "USD", input_per_1M_tokens: 0.15825, output_per_1M_tokens: 0.633 },
};
const parse = (data: unknown[]) => parseProviderModels(normalizePerMillionCatalogue({ data }));

test("upstream prices become per-token rates with exact million-token billing", () => {
  const { ok, errors } = parse([model]);
  expect(errors).toEqual([]);
  expect(ok[0].pricing).toEqual({ prompt: "0.00000015825", completion: "0.000000633" });
  expect(tokenCost(1_000_000, usdToPico(ok[0].pricing.prompt))).toBe(usdToPico("0.15825"));
  expect(ok[0].created).toBe(1721260800);
  expect(ok[0].input_modalities).toEqual(["text", "image"]);
  expect(ok[0].supported_parameters).toEqual(["tools", "temperature"]);
});

test("upstream excludes encrypted/private and non-chat models", () => {
  const result = parse([model, { ...model, id: "private/test" }, { ...model, privacyLevel: "e2e" }, { ...model, type: "image" }]);
  expect(result.ok).toHaveLength(1);
  expect(result.errors).toEqual([]);
});

test("upstream invalid or unsupported prices cannot create free offers", () => {
  for (const pricing of [undefined, {}, { ...model.pricing, currency: "EUR" },
    { ...model.pricing, type: "variable" }, { ...model.pricing, input_per_1M_tokens: -1 },
    { ...model.pricing, input_per_1M_tokens: Infinity }, { ...model.pricing, output_per_1M_tokens: null }]) {
    const result = parse([{ ...model, pricing }]);
    expect(result.ok).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
  }
});

test("upstream preserves zero rates and rounds sub-pico rates upward", () => {
  const { ok } = parse([{ ...model, pricing: { ...model.pricing, input_per_1M_tokens: 0, output_per_1M_tokens: 0.0000001 } }]);
  expect(ok[0].pricing).toEqual({ prompt: "0", completion: "0.000000000001" });
});

test("upstream malformed catalogue produces validation errors", () => {
  expect(parseProviderModels(normalizePerMillionCatalogue({ data: null })).errors).toHaveLength(1);
  expect(parse([null]).errors).toHaveLength(1);
});

test("upstream catalogue provisioning rolls back atomically on transaction failure", async () => {
  const handle = await openDatabase("pglite://memory");
  const cfg = { appSecret: "test-only-upstream-secret", production: true };
  try {
    const provision = async (rollback: boolean) => handle.db.transaction(async (db) => {
      const [provider] = await db.insert(providers).values({
        id: "upstream", name: "upstream", baseUrl: "https://upstream.example/v1", status: "live",
        staticModels: parse([model]).ok,
      }).returning();
      await syncProvider({ db, cfg }, provider);
      if (rollback) throw new Error("rollback fixture");
    });
    await expect(provision(true)).rejects.toThrow("rollback fixture");
    expect(await handle.db.select().from(providers)).toHaveLength(0);
    expect(await handle.db.select().from(offers)).toHaveLength(0);
    await provision(false);
    const rows = await handle.db.select().from(offers);
    expect(rows).toHaveLength(1);
    expect(rows[0].pricePrompt).toBe(158250n);
    expect(rows[0].priceCompletion).toBe(633000n);
    expect(rows[0].status).toBe("live");
  } finally { await handle.close(); }
});
