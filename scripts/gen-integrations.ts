// Regenerates the catalogue-derived listing files under integrations/litellm/ from the public model list:
//   model_prices_and_context_window.anyroute.json  LiteLLM cost-map entries, one per model, provider "anyroute"
//   provider.json                                  LiteLLM JSON registration for an OpenAI-compatible provider
//   config.yaml                                    a sample LiteLLM proxy config that works with no LiteLLM change
//
// Usage: bun scripts/gen-integrations.ts [--from <models.json>] [--base <router url>] [--out <dir>]
//   --from  read a saved /api/v1/models response instead of fetching it
//   --base  the router to fetch from and to point the configs at (default: the live router)
//   --out   where to write (default: integrations/litellm next to this repo's scripts/)
//
// /api/v1/models is public, so this needs no key and sends nothing but one GET.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

export const DEFAULT_ROUTER = "https://api-production-70da.up.railway.app";
export const LITELLM_PROVIDER = "anyroute";

/** The fields of a /api/v1/models entry this generator reads. */
export type CatalogueModel = {
  id: string;
  context_length?: number | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] } | null;
  pricing?: Record<string, string | number | null | undefined> | null;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
  supported_parameters?: string[] | null;
  attested_available?: boolean | null;
};

/** One entry of LiteLLM's model_prices_and_context_window.json. Optional capability flags appear only when true. */
export type LiteLLMEntry = {
  litellm_provider: typeof LITELLM_PROVIDER;
  mode: "chat" | "embedding";
  max_tokens: number;
  max_input_tokens: number;
  max_output_tokens?: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  supports_function_calling: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  supports_tool_choice?: true;
  supports_parallel_function_calling?: true;
  supports_response_schema?: true;
  supports_pdf_input?: true;
  supports_audio_input?: true;
  supports_audio_output?: true;
  supports_web_search?: true;
  supports_prompt_caching?: true;
};

/** USD per token from a catalogue price string. Missing, negative (priced per route at call time) or non-numeric is null. */
export function perToken(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The LiteLLM entry for one catalogue model, or null when it cannot have a fixed one: ids starting with `~` are
 * moving aliases (their target and price change), and a model with no fixed per-token price or no context length
 * would give LiteLLM wrong costs.
 */
export function litellmEntry(m: CatalogueModel): LiteLLMEntry | null {
  if (!m.id || m.id.startsWith("~")) return null;
  const input = perToken(m.pricing?.prompt);
  const output = perToken(m.pricing?.completion);
  const context = m.context_length ?? m.top_provider?.context_length ?? null;
  if (input === null || output === null || !context || context <= 0) return null;

  const params = new Set(m.supported_parameters ?? []);
  const inputs = new Set(m.architecture?.input_modalities ?? []);
  const outputs = new Set(m.architecture?.output_modalities ?? []);
  const maxOut = m.top_provider?.max_completion_tokens ?? null;
  const cacheRead = perToken(m.pricing?.input_cache_read);

  const e: LiteLLMEntry = {
    litellm_provider: LITELLM_PROVIDER,
    mode: outputs.has("embeddings") ? "embedding" : "chat",
    // LiteLLM's legacy max_tokens is the output limit when known, else the input limit.
    max_tokens: maxOut && maxOut > 0 ? maxOut : context,
    max_input_tokens: context,
    input_cost_per_token: input,
    output_cost_per_token: output,
    supports_function_calling: params.has("tools"),
    supports_vision: inputs.has("image"),
    supports_reasoning: params.has("reasoning") || params.has("include_reasoning") || params.has("reasoning_effort"),
  };
  if (maxOut && maxOut > 0) e.max_output_tokens = maxOut;
  if (cacheRead !== null && cacheRead > 0) {
    e.cache_read_input_token_cost = cacheRead;
    e.supports_prompt_caching = true;
  }
  if (params.has("tool_choice")) e.supports_tool_choice = true;
  if (params.has("parallel_tool_calls")) e.supports_parallel_function_calling = true;
  if (params.has("structured_outputs")) e.supports_response_schema = true;
  if (params.has("web_search_options")) e.supports_web_search = true;
  if (inputs.has("file")) e.supports_pdf_input = true;
  if (inputs.has("audio")) e.supports_audio_input = true;
  if (outputs.has("audio")) e.supports_audio_output = true;
  return e;
}

/** LiteLLM entries keyed `anyroute/<model id>`, sorted by key so reruns diff cleanly. */
export function toLiteLLM(models: CatalogueModel[]): { entries: Record<string, LiteLLMEntry>; skipped: string[] } {
  const entries: Record<string, LiteLLMEntry> = {};
  const skipped: string[] = [];
  for (const m of [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const e = litellmEntry(m);
    if (e) entries[`${LITELLM_PROVIDER}/${m.id}`] = e;
    else skipped.push(m.id);
  }
  return { entries, skipped };
}

/** LiteLLM's JSON registration for a plain OpenAI-compatible provider (litellm/llms/openai_like/providers.json). */
export const litellmProvider = (base: string) => ({
  [LITELLM_PROVIDER]: { base_url: `${base.replace(/\/$/, "")}/api/v1`, api_key_env: "ANYROUTE_API_KEY" },
});

/** Models the sample proxy config lists, when the catalogue has them. `lane` adds the attested-only header. */
export const SAMPLE_MODELS: { name: string; id: string; lane?: "attested" }[] = [
  { name: "llama-3.3-70b", id: "meta-llama/llama-3.3-70b-instruct" },
  { name: "hermes-4-405b", id: "nousresearch/hermes-4-405b" },
  { name: "deepseek-v3.2", id: "deepseek/deepseek-v3.2" },
  { name: "glm-5.3-attested", id: "z-ai/glm-5.3", lane: "attested" },
  { name: "qwen3-vl-30b", id: "qwen/qwen3-vl-30b-a3b-instruct" },
  { name: "qwen3-embedding-8b", id: "qwen/qwen3-embedding-8b" },
];

/** A LiteLLM proxy config using the `openai/` route, so it works on any LiteLLM version with no upstream change. */
export function litellmConfigYaml(models: CatalogueModel[], base: string): string {
  const byId = new Map(models.map((m) => [m.id, m]));
  const apiBase = `${base.replace(/\/$/, "")}/api/v1`;
  const model_list = SAMPLE_MODELS.flatMap((s) => {
    const m = byId.get(s.id);
    const e = m && litellmEntry(m);
    if (!e) return [];
    return [
      {
        model_name: s.name,
        litellm_params: {
          model: `openai/${s.id}`,
          api_base: apiBase,
          api_key: "os.environ/ANYROUTE_API_KEY",
          ...(s.lane ? { extra_headers: { "X-Anyroute-Lane": s.lane } } : {}),
          input_cost_per_token: e.input_cost_per_token,
          output_cost_per_token: e.output_cost_per_token,
        },
        model_info: { mode: e.mode, max_input_tokens: e.max_input_tokens, supports_function_calling: e.supports_function_calling, supports_vision: e.supports_vision },
      },
    ];
  });
  const header = [
    "# LiteLLM proxy config for Anyroute. Generated by scripts/gen-integrations.ts from the live catalogue.",
    "# Run: ANYROUTE_API_KEY=sk-ar-v1-... litellm --config config.yaml",
    "# Any other model: add an entry with model: openai/<id from GET /api/v1/models>.",
    "# glm-5.3-attested sends X-Anyroute-Lane: attested, so the router only uses providers with a verified enclave",
    "# and refuses (sending nothing) when none can answer.",
  ].join("\n");
  return `${header}\n${stringify({ model_list }, { lineWidth: 0 })}`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const base = (arg("--base") ?? process.env.ANYROUTE_URL ?? DEFAULT_ROUTER).replace(/\/$/, "");
  const from = arg("--from");
  const out = arg("--out") ?? join(import.meta.dir, "..", "integrations", "litellm");
  let body: { data?: CatalogueModel[] };
  if (from) body = JSON.parse(readFileSync(from, "utf8"));
  else {
    const res = await fetch(`${base}/api/v1/models`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET ${base}/api/v1/models answered ${res.status}`);
    body = (await res.json()) as { data?: CatalogueModel[] };
  }
  const models = body.data ?? [];
  if (!models.length) throw new Error("The catalogue is empty; refusing to overwrite the listing files.");
  const { entries, skipped } = toLiteLLM(models);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "model_prices_and_context_window.anyroute.json"), `${JSON.stringify(entries, null, 4)}\n`);
  writeFileSync(join(out, "provider.json"), `${JSON.stringify(litellmProvider(base), null, 4)}\n`);
  writeFileSync(join(out, "config.yaml"), litellmConfigYaml(models, base));
  console.log(`catalogue: ${models.length} models; LiteLLM entries: ${Object.keys(entries).length}; left out (moving alias or no fixed price): ${skipped.length}`);
}

if (import.meta.main) await main();
