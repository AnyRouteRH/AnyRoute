import { Hono } from "hono";
import { randomBytes } from "node:crypto";

// A configurable OpenAI-compatible provider used by tests, the local demo and canary development.
// It speaks the provider spec (/models with pricing/quantization/features), chat/completions
// (JSON + SSE), legacy completions, embeddings, logprobs, and a TEE-style attestation endpoint.
// Behaviours can be switched at runtime through POST /_control.

export type MockBehaviour = "ok" | "empty200" | "error500" | "rate429" | "slow" | "hang" | "reject400" | "midstream_error" | "no_usage" | "auth401";
export type MockModel = { id: string; slug?: string; prompt: string; completion: string; ctx?: number; quant?: string; features?: string[]; params?: string[]; creator?: string; output?: string[] };
export type MockConfig = {
  name: string;
  models: MockModel[];
  behaviour?: MockBehaviour;
  quantNoise?: number; // perturbs logprobs to imitate lower precision
  delayMs?: number;
  tee?: "dev" | null;
  wrongAnswers?: boolean; // degrade the canary benchmark
};

const WORDS = "the quick brown fox jumps over the lazy dog and keeps running far away".split(" ");
const ANSWERS: Record<string, string> = {
  "17 * 23": "391",
  "capital of australia": "Canberra",
  "'router' backwards": "retuor",
  "2 to the power of 10": "1024",
  "closest to the sun": "Mercury",
  "hexagon": "6",
  "symbol for gold": "Au",
  "144 divided by 12": "12",
};

function answerFor(prompt: string, cfg: MockConfig) {
  const lower = prompt.toLowerCase();
  for (const [k, v] of Object.entries(ANSWERS)) if (lower.includes(k.toLowerCase())) return cfg.wrongAnswers ? "I am not sure" : v;
  if (lower.includes("next ten words")) return WORDS.slice(0, 10).join(" ");
  return `Hello from ${cfg.name}. You said: ${prompt.slice(0, 200)}`;
}

function logprobsFor(text: string, noise: number) {
  const toks = text.split(/(?=\s)/).slice(0, 12);
  return {
    content: toks.map((tok, i) => {
      const base = -0.05 - i * 0.02;
      const jitter = noise ? Math.sin(i * 7.3 + tok.length) * noise : 0;
      return {
        token: tok,
        logprob: base + jitter,
        top_logprobs: [
          { token: tok, logprob: base + jitter },
          { token: " alt" + i, logprob: -3 - i * 0.1 - jitter },
          { token: " other" + i, logprob: -4.5 - i * 0.05 + jitter / 2 },
        ],
      };
    }),
  };
}
