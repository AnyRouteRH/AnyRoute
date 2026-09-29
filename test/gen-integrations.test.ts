import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import fixture from "./fixtures/integrations-models.json";
import { type CatalogueModel, litellmConfigYaml, litellmEntry, litellmProvider, perToken, toLiteLLM } from "../scripts/gen-integrations.ts";

const models = fixture.data as CatalogueModel[];
const byId = (id: string) => models.find((m) => m.id === id)!;
const BASE = "https://router.example";

describe("catalogue -> LiteLLM entries", () => {
  const { entries, skipped } = toLiteLLM(models);

  test("keys are anyroute/<id>, sorted, and every entry has LiteLLM's required shape", () => {
    const keys = Object.keys(entries);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "anyroute/meta-llama/llama-3.3-70b-instruct",
      "anyroute/nousresearch/hermes-4-405b",
      "anyroute/openai/gpt-6.1-sol-pro",
      "anyroute/qwen/qwen3-embedding-8b",
      "anyroute/z-ai/glm-5.3",
    ]);
    for (const e of Object.values(entries)) {
      expect(e.litellm_provider).toBe("anyroute");
      expect(["chat", "embedding"]).toContain(e.mode);
      for (const k of ["max_tokens", "max_input_tokens", "input_cost_per_token", "output_cost_per_token"] as const) expect(typeof e[k]).toBe("number");
      for (const k of ["supports_function_calling", "supports_vision", "supports_reasoning"] as const) expect(typeof e[k]).toBe("boolean");
      // Optional flags are present only when true, so a reviewer never sees a misleading `false` for an unknown.
      for (const [k, v] of Object.entries(e)) if (k.startsWith("supports_") && !["supports_function_calling", "supports_vision", "supports_reasoning"].includes(k)) expect(v).toBe(true);
    }
  });

  test("leaves out moving aliases, dynamic prices and models without a context length", () => {
    expect(skipped.sort()).toEqual(["anyroute/auto-priced", "example/no-context", "~z-ai/glm-latest"]);
  });

  test("prices are USD per token, straight from the catalogue strings", () => {
    const glm = entries["anyroute/z-ai/glm-5.3"]!;
    expect(glm.input_cost_per_token).toBe(0.0000014);
    expect(glm.output_cost_per_token).toBe(0.0000044);
    expect(entries["anyroute/nousresearch/hermes-4-405b"]!.input_cost_per_token).toBe(0);
    expect(perToken("-1")).toBeNull();
    expect(perToken("abc")).toBeNull();
    expect(perToken(undefined)).toBeNull();
    expect(perToken("0")).toBe(0);
  });

  test("context and output limits", () => {
    const glm = entries["anyroute/z-ai/glm-5.3"]!;
    expect(glm).toMatchObject({ max_input_tokens: 1048576, max_output_tokens: 131072, max_tokens: 131072 });
    // Unknown (null) or zero output limit: no max_output_tokens, and the legacy max_tokens falls back to the context.
    const llama = entries["anyroute/meta-llama/llama-3.3-70b-instruct"]!;
    expect(llama.max_output_tokens).toBeUndefined();
    expect(llama.max_tokens).toBe(131072);
    expect(entries["anyroute/nousresearch/hermes-4-405b"]!.max_output_tokens).toBeUndefined();
  });

  test("capability flags map from supported_parameters and modalities", () => {
    expect(entries["anyroute/z-ai/glm-5.3"]).toMatchObject({
      supports_function_calling: true,
      supports_tool_choice: true,
      supports_reasoning: true,
      supports_response_schema: true,
      supports_vision: false,
    });
    const sol = entries["anyroute/openai/gpt-6.1-sol-pro"]!;
    expect(sol).toMatchObject({
      supports_function_calling: true,
      supports_parallel_function_calling: true,
      supports_reasoning: true, // from reasoning_effort alone
      supports_web_search: true,
      supports_vision: true,
      supports_pdf_input: true,
      supports_audio_input: true,
      supports_audio_output: true,
    });
    expect(sol.supports_response_schema).toBeUndefined();
    const hermes = entries["anyroute/nousresearch/hermes-4-405b"]!;
    expect(hermes).toMatchObject({ supports_function_calling: false, supports_vision: false, supports_reasoning: false });
    expect(hermes.supports_tool_choice).toBeUndefined();
  });

  test("prompt caching only when a positive cache-read price exists", () => {
    const sol = entries["anyroute/openai/gpt-6.1-sol-pro"]!;
    expect(sol.cache_read_input_token_cost).toBe(0.000000211);
    expect(sol.supports_prompt_caching).toBe(true);
    const hermes = entries["anyroute/nousresearch/hermes-4-405b"]!;
    expect(hermes.cache_read_input_token_cost).toBeUndefined();
    expect(hermes.supports_prompt_caching).toBeUndefined();
  });

  test("embedding models get mode embedding", () => {
    expect(entries["anyroute/qwen/qwen3-embedding-8b"]).toMatchObject({ mode: "embedding", input_cost_per_token: 0.00000001, output_cost_per_token: 0 });
    expect(litellmEntry(byId("z-ai/glm-5.3"))!.mode).toBe("chat");
  });
});

describe("LiteLLM provider registration and sample config", () => {
  test("provider.json points at /api/v1 and reads the key from ANYROUTE_API_KEY", () => {
    expect(litellmProvider(`${BASE}/`)).toEqual({ anyroute: { base_url: `${BASE}/api/v1`, api_key_env: "ANYROUTE_API_KEY" } });
  });

  test("config.yaml lists only sample models the catalogue has, with their catalogue prices", () => {
    const cfg = parse(litellmConfigYaml(models, BASE)) as { model_list: any[] };
    const names = cfg.model_list.map((m) => m.model_name);
    expect(names).toEqual(["llama-3.3-70b", "hermes-4-405b", "glm-5.3-attested", "qwen3-embedding-8b"]);
    for (const m of cfg.model_list) {
      expect(m.litellm_params.model).toStartWith("openai/");
      expect(m.litellm_params.api_base).toBe(`${BASE}/api/v1`);
      expect(m.litellm_params.api_key).toBe("os.environ/ANYROUTE_API_KEY");
    }
    const glm = cfg.model_list.find((m) => m.model_name === "glm-5.3-attested");
    expect(glm.litellm_params).toMatchObject({ model: "openai/z-ai/glm-5.3", extra_headers: { "X-Anyroute-Lane": "attested" }, input_cost_per_token: 0.0000014, output_cost_per_token: 0.0000044 });
    expect(cfg.model_list.find((m) => m.model_name === "llama-3.3-70b").litellm_params.extra_headers).toBeUndefined();
    expect(cfg.model_list.find((m) => m.model_name === "qwen3-embedding-8b").model_info.mode).toBe("embedding");
  });

  test("the CLI writes all three files from a saved catalogue without touching the network", () => {
    const out = mkdtempSync(join(tmpdir(), "gen-integrations-"));
    try {
      const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "scripts", "gen-integrations.ts"), "--from", join(import.meta.dir, "fixtures", "integrations-models.json"), "--base", BASE, "--out", out]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("LiteLLM entries: 5");
      const json = JSON.parse(readFileSync(join(out, "model_prices_and_context_window.anyroute.json"), "utf8"));
      expect(json).toEqual(toLiteLLM(models).entries);
      expect(JSON.parse(readFileSync(join(out, "provider.json"), "utf8")).anyroute.base_url).toBe(`${BASE}/api/v1`);
      expect(readFileSync(join(out, "config.yaml"), "utf8")).toStartWith("# LiteLLM proxy config for Anyroute.");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
