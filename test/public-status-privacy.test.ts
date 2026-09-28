import { expect, test } from "bun:test";
import { startRouter, ADMIN } from "./helpers.ts";

test("public status omits operator RPC URLs and job exception content", async () => {
  const h = await startRouter();
  const privateValue = "fixture-private-credential";
  try {
    h.ctx.cfg.chain.rpcUrl = `https://rpc.example.test/v1/${privateValue}?key=${privateValue}`;
    h.ctx.jobs.register("privacy-fixture", 1000, async () => { throw new Error(`Provider failed at ${privateValue}`); });
    await expect(h.ctx.jobs.run("privacy-fixture")).rejects.toThrow(privateValue);
    const response = await h.request("/api/v1/status");
    expect(response.status).toBe(200);
    const status = (await response.json()).data;
    expect(status.chain).not.toHaveProperty("rpc");
    expect(status.chain.public_rpc).toBe(h.ctx.cfg.chain.publicRpcUrl);
    expect(JSON.stringify(status)).not.toContain(privateValue);
    expect(status.jobs.find((job: { name: string }) => job.name === "privacy-fixture").last_error).toBe("Job failed");
    const operator = await h.request("/trpc/jobs.status", { headers: { "x-admin-token": ADMIN } });
    expect(operator.status).toBe(200);
    expect(await operator.text()).toContain(privateValue);
  } finally { await h.close(); }
});
