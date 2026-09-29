// bun examples/generate.ts  (needs ANYROUTE_API_KEY)
import { embed, generateText, streamText } from "ai";
import { anyroute, createAnyroute } from "../src/index.ts";

const { text, providerMetadata } = await generateText({
  model: anyroute("meta-llama/llama-3.3-70b-instruct"),
  prompt: "Say hello in five words.",
});
console.log(text, providerMetadata?.anyroute); // { receiptId, receiptKeyId, costUsd }

// Attested lane: only providers with a verified enclave, or a refusal with nothing sent.
const attested = createAnyroute({ lane: "attested" });
const stream = streamText({ model: attested("z-ai/glm-5.3"), prompt: "One fact about enclaves." });
for await (const part of stream.textStream) process.stdout.write(part);
console.log("\n", await stream.providerMetadata);

const { embedding } = await embed({ model: anyroute.embeddingModel("qwen/qwen3-embedding-8b"), value: "any route" });
console.log(embedding.length);
