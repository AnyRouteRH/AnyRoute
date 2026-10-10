// E151: the model page consumes existing public routes; it creates no account or storage records.
import { expect, test } from "bun:test";
import { startRouter, MODELS } from "./helpers.ts";

test("model-page inputs are public with optional arrival tracking off", async () => {
  const h = await startRouter({ env: { MODEL_ARRIVALS_ENABLED: "false" } });
  try {
    const list = await h.request("/api/v1/models");
    expect(list.status).toBe(200);
    const models = (await list.json()).data;
    const model = models.find((row: { id: string }) => row.id === MODELS.llama.slug);
    expect(model).toBeDefined();
    expect(model.added_at).toBeUndefined();
    expect(model.provider_names).toContain("Alpha");
    expect(model.pricing.prompt).toBe(MODELS.llama.prompt);
    const providers = await h.request("/api/v1/providers");
    expect(providers.status).toBe(200);
    expect((await providers.json()).data.find((row: { slug: string }) => row.slug === "alpha").attestation.status).toBe("unverified");
    const endpoints = await h.request(`/api/v1/models/${MODELS.llama.slug}/endpoints`);
    expect(endpoints.status).toBe(200);
    const rows = (await endpoints.json()).data.endpoints;
    expect(rows.find((row: { provider_slug: string }) => row.provider_slug === "alpha")).toMatchObject({ uptime_last_30d: null, latency_last_30m: null, throughput_last_30m: null });
    // An invalid credential is refused for inference; public catalogue reads need no credential.
    expect((await h.request("/api/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer invalid-credential" }, json: { model: MODELS.llama.slug, messages: [{ role: "user", content: "Hello" }] } })).status).toBe(401);
    expect((await h.request("/api/v1/models/sample/unknown/endpoints")).status).toBe(404);
  } finally { await h.close(); }
});
