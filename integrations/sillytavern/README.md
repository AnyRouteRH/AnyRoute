# SillyTavern

Anyroute works in [SillyTavern](https://sillytavern.app) today through the built-in **Custom (OpenAI-compatible)** Chat Completion source. No extension needed.

## Connect (2 minutes)

1. Open **API Connections** (the plug icon).
2. **API**: `Chat Completion`. **Chat Completion Source**: `Custom (OpenAI-compatible)`.
3. **Custom Endpoint (Base URL)**: `https://anyroute.tech/api/v1`
4. **Custom API Key**: your Anyroute key (`sk-ar-v1-...`). SillyTavern keeps it in its secrets store, not in presets.
5. **Available Models** loads the live catalogue from `/models`. Pick one, or type an id into **Enter a Model ID**.
6. Click **Connect**, then save it as a **Connection Profile** so you can switch back in one click.

Model ids to start with:

| Id | Why |
| --- | --- |
| `deepseek/deepseek-v3.2` | strong and cheap, has attested endpoints |
| `z-ai/glm-5.3` | long context (1M), has attested endpoints |
| `nousresearch/hermes-4-405b` | popular for roleplay |
| `thedrummer/...`, `sao10k/...`, `undi95/...` | community finetunes; search the model list |

The full list with prices: `https://anyroute.tech/models`.

## Attested only

To keep a chat on providers whose TEE enclave the router has verified, add this under **Additional Parameters > Include Body Parameters**:

```yaml
provider:
  lane: attested
```

The router then refuses (sending nothing, charging nothing) when no attested provider can answer, instead of falling back. Attested models are marked `attested_available: true` in `GET /api/v1/models`.

## Preset file

`anyroute-preset.json` is a Chat Completion preset with the source, endpoint and a model filled in. Import it under **AI Response Configuration > Import preset**. If your SillyTavern version ignores the connection fields in a preset, set steps 2 to 5 by hand; the rest of the preset (sampling) still applies. It holds no key.

## Submit (not done yet)

A native source (an "Anyroute" entry in the Chat Completion Source list, with the receipt id shown per message) would be a PR to `SillyTavern/SillyTavern` on the `staging` branch, modelled on an existing OpenAI-compatible source. This recipe is what to link from the SillyTavern docs and Discord until then.
