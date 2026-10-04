# LiteLLM

Anyroute in LiteLLM, two ways: use it today with the sample config, or submit it upstream so `anyroute/<model>` works out of the box with correct costs.

| File | What it is |
| --- | --- |
| `config.yaml` | LiteLLM proxy config. Works now on any LiteLLM version, no upstream change needed. |
| `model_prices_and_context_window.anyroute.json` | One LiteLLM cost-map entry per catalogue model: price per token, context, capability flags. |
| `provider.json` | LiteLLM's JSON registration for an OpenAI-compatible provider. |

All three are generated from the live catalogue (`GET /api/v1/models`, public, no key):

```sh
bun scripts/gen-integrations.ts                 # fetch the live catalogue and rewrite these files
bun scripts/gen-integrations.ts --from models.json   # or from a saved response
```

## Use it now

```sh
pip install 'litellm[proxy]'
export ANYROUTE_API_KEY=sk-ar-v1-...
litellm --config integrations/litellm/config.yaml
```

Then call the proxy with any OpenAI client and a `model_name` from the config (`llama-3.3-70b`, `glm-5.3-attested`, ...). For another model add an entry with `model: openai/<id>`. The `glm-5.3-attested` entry sends `X-Anyroute-Lane: attested`: the router only uses providers whose enclave it verified, and refuses (sending nothing, charging nothing) when none can answer.

From the Python SDK, without the proxy:

```python
import litellm
litellm.completion(model="openai/meta-llama/llama-3.3-70b-instruct",
                   api_base="https://anyroute.tech/api/v1",
                   api_key=os.environ["ANYROUTE_API_KEY"],
                   messages=[{"role": "user", "content": "hi"}])
```

To get LiteLLM's cost tracking for every model locally: `litellm.register_model(json.load(open("model_prices_and_context_window.anyroute.json")))`.

## How the entries are built

| LiteLLM field | From the catalogue |
| --- | --- |
| key | `anyroute/<id>` |
| `input_cost_per_token`, `output_cost_per_token` | `pricing.prompt`, `pricing.completion` (USD per token) |
| `cache_read_input_token_cost`, `supports_prompt_caching` | `pricing.input_cache_read` when above 0 |
| `max_input_tokens` | `context_length` |
| `max_output_tokens` | `top_provider.max_completion_tokens` when known |
| `max_tokens` | the output limit when known, else the context length (LiteLLM's legacy field) |
| `mode` | `embedding` when the model outputs embeddings, else `chat` |
| `supports_function_calling` / `supports_tool_choice` / `supports_parallel_function_calling` | `tools` / `tool_choice` / `parallel_tool_calls` in `supported_parameters` |
| `supports_reasoning` | `reasoning`, `include_reasoning` or `reasoning_effort` |
| `supports_response_schema` | `structured_outputs` |
| `supports_web_search` | `web_search_options` |
| `supports_vision` / `supports_pdf_input` / `supports_audio_input` | `image` / `file` / `audio` in `input_modalities` |
| `supports_audio_output` | `audio` in `output_modalities` |

Left out: `~` ids (moving aliases whose target and price change) and any model without a fixed per-token price or a context length.

## Submit upstream (not done yet)

1. Fork `BerriAI/litellm`.
2. Add the `anyroute` block from `provider.json` to `litellm/llms/openai_like/providers.json` (LiteLLM's registry for plain OpenAI-compatible providers). If that file has moved, follow LiteLLM's current "add an OpenAI-compatible provider" contributing guide.
3. Merge the entries of `model_prices_and_context_window.anyroute.json` into `model_prices_and_context_window.json` and `litellm/model_prices_and_context_window_backup.json`.
4. Add a provider docs page (`docs/my-website/docs/providers/anyroute.md`) based on "Use it now" above.
5. Run their JSON validity test, open the PR. Regenerate the entries right before submitting so prices are current.
