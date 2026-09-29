import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { boot } from "../src/boot.ts";
import { parseConfig } from "../src/config.ts";
import { main } from "../src/cli.ts";
import { FILES } from "../src/onboard/state.ts";
import { startServer } from "../src/server.ts";
import { silentLogger } from "../src/util.ts";
import { cleanup, dstackProvider, startUpstream, tmpDir } from "./helpers.ts";
import { gpuFlags, scriptedIo, weightsDir } from "./onboard-helpers.ts";

afterEach(cleanup);
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

/**
 * The whole path a model host takes: `init` writes the files, the sidecar boots from the generated sidecar.yaml (with the
 * container paths swapped for local ones and a double standing in for the guest agent), `doctor` checks it using the
 * generated key and manifest, and `apply` files the application.
 */
async function deployed(extraInit: string[] = []) {
  const weights = weightsDir();
  const out = join(tmpDir(), "provider");
  const io = scriptedIo();
  expect(await main(["init", ...gpuFlags(weights, out, ["--served-name", "tiny", ...extraInit])], { io })).toBe(0);

  const generated = Bun.YAML.parse(readFileSync(join(out, FILES.yaml), "utf8")) as Record<string, any>;
  const upstream = startUpstream();
  const local = {
    ...generated,
    model: { ...generated.model, path: weights },
    upstream: { ...generated.upstream, base_url: upstream.url },
    server: { ...generated.server, hostnames: ["127.0.0.1"] },
  };
  const cfg = parseConfig(local, {});
  const rt = await boot(cfg, { env: {}, logger: silentLogger, provider: dstackProvider({ composeHash: `sha256:${"ce".repeat(32)}` }) });
  const server = startServer({ ...rt, cfg: { ...rt.cfg, server: { ...rt.cfg.server, host: "127.0.0.1", port: 0 } } });
  servers.push(server);
  return { out, weights, io, upstream, base: `https://127.0.0.1:${server.port}` };
}

describe("init, boot, doctor", () => {
  test("the generated configuration boots a sidecar whose served digest is the one init computed", async () => {
    const d = await deployed();
    const io = scriptedIo();
    const code = await main(["doctor", "--dir", d.out, "--url", d.base], { io });
    expect(io.outText()).toContain("PASS  a response carries a valid signed receipt");
    expect(io.outText()).not.toMatch(/^FAIL/m);
    expect(code).toBe(0);
    // the key doctor used is the generated one, and the digest it compared is the manifest's
    expect(io.outText()).toContain("equals the digest of the weights init hashed");
    expect(d.upstream.seen.some((s) => s.path === "/v1/chat/completions" && JSON.parse(s.body).model === "tiny")).toBe(true);
  });

  test("hashing the weights again is the same check, and changed weights fail it", async () => {
    const d = await deployed();
    const same = scriptedIo();
    expect(await main(["doctor", "--dir", d.out, "--url", d.base, "--weights", d.weights, "--no-chat"], { io: same })).toBe(0);
    expect(same.outText()).toContain("the weights hashed just now");
    await Bun.write(join(d.weights, "model.safetensors"), "different weights");
    const changed = scriptedIo();
    expect(await main(["doctor", "--dir", d.out, "--url", d.base, "--weights", d.weights, "--no-chat"], { io: changed })).toBe(1);
    expect(changed.outText()).toMatch(/FAIL  served weights equal the weights you hashed/);
  });

  test("--json is machine readable, and a broken endpoint exits 1", async () => {
    const d = await deployed();
    const io = scriptedIo();
    expect(await main(["doctor", "--dir", d.out, "--url", d.base, "--json", "--no-chat"], { io })).toBe(0);
    const report = JSON.parse(io.outText());
    expect(report.ok).toBe(true);
    expect(report.checks.find((c: any) => c.id === "healthz").status).toBe("pass");
    const down = scriptedIo();
    expect(await main(["doctor", "--dir", d.out, "--url", "https://127.0.0.1:1"], { io: down })).toBe(1);
    expect(down.outText()).toContain("FAIL  GET /attest");
  });
});

describe("apply", () => {
  const routerStub = () => {
    const calls: { url: string; body: any; headers: Headers }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      return new Response(JSON.stringify({ data: { id: "demo-model", status: "applied", models_found: 0, application_token: "tok-" + "a".repeat(20), next: ["Keep your application token."] } }), { status: 201 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  test("prints the exact body, keeps the router key out of it by default, and submits only when asked", async () => {
    const d = await deployed();
    const stub = routerStub();
    const io = scriptedIo();
    expect(await main(["apply", "--dir", d.out, "--url", d.base, "--router", "https://router.example"], { io, fetchImpl: stub.fetchImpl })).toBe(0);
    expect(stub.calls).toHaveLength(0);
    const printed = JSON.parse(io.outText().split("\n").slice(1).join("\n"));
    const file = JSON.parse(readFileSync(join(d.out, FILES.applicationJson), "utf8"));
    expect(printed).toEqual(file);
    expect(file).toEqual({
      id: "demo-model",
      name: "demo-model",
      base_url: `${d.base}/v1`,
      data_policy: { training: false, retains_prompts: false, retention_days: 0 },
      tee: { kind: "tdx", attestation_url: `${d.base}/attest` },
    });
    expect(io.errText()).toContain("Not submitted");
  });

  test("--submit posts it once to the router's apply endpoint and keeps the application token private", async () => {
    const d = await deployed();
    const stub = routerStub();
    const io = scriptedIo();
    expect(await main(["apply", "--dir", d.out, "--url", d.base, "--router", "https://router.example", "--submit"], { io, fetchImpl: stub.fetchImpl })).toBe(0);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe("https://router.example/api/v1/providers/apply");
    expect(stub.calls[0].body).toEqual(JSON.parse(readFileSync(join(d.out, FILES.applicationJson), "utf8")));
    expect(stub.calls[0].body).not.toHaveProperty("api_key");
    const tokenPath = join(d.out, FILES.applicationToken);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe("tok-" + "a".repeat(20));
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(io.outText() + io.errText()).not.toContain("tok-aaaa");
  });

  test("--include-key sends the router key, masks it on the terminal, and writes the file 0600", async () => {
    const d = await deployed();
    const key = readFileSync(join(d.out, FILES.key), "utf8").trim();
    const stub = routerStub();
    const io = scriptedIo();
    expect(await main(["apply", "--dir", d.out, "--url", d.base, "--router", "https://router.example", "--submit", "--include-key"], { io, fetchImpl: stub.fetchImpl })).toBe(0);
    expect(stub.calls[0].body.api_key).toBe(key);
    expect(io.outText() + io.errText()).not.toContain(key);
    expect(statSync(join(d.out, FILES.applicationJson)).mode & 0o777).toBe(0o600);
    const printed = scriptedIo();
    await main(["apply", "--dir", d.out, "--url", d.base, "--include-key", "--print-secrets"], { io: printed, fetchImpl: stub.fetchImpl });
    expect(printed.outText()).toContain(key);
  });

  test("refuses to send the key over plain http, an http endpoint, or a submit with no router", async () => {
    const d = await deployed();
    const stub = routerStub();
    for (const [argv, re] of [
      [["apply", "--dir", d.out, "--url", d.base, "--router", "http://router.example", "--submit"], /must be https/],
      [["apply", "--dir", d.out, "--url", "http://provider.example"], /must be https/],
      [["apply", "--dir", d.out, "--url", d.base, "--submit"], /--submit needs --router/],
      [["apply", "--dir", d.out], /--url/],
    ] as const) {
      const io = scriptedIo();
      expect(await main([...argv], { io, fetchImpl: stub.fetchImpl })).toBe(2);
      expect(io.errText()).toMatch(re);
    }
    expect(stub.calls).toHaveLength(0);
  });

  test("a refusal from the router is reported with its reason and exits 1", async () => {
    const d = await deployed();
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "That provider id is already registered." } }), { status: 409 })) as unknown as typeof fetch;
    const io = scriptedIo();
    expect(await main(["apply", "--dir", d.out, "--url", d.base, "--router", "https://router.example", "--submit"], { io, fetchImpl })).toBe(1);
    expect(io.errText()).toContain("409");
    expect(io.errText()).toContain("already registered");
  });

  test("init --url --router --submit files it in one go", async () => {
    const weights = weightsDir();
    const out = join(tmpDir(), "p");
    const stub = routerStub();
    const io = scriptedIo();
    const code = await main(["init", ...gpuFlags(weights, out, ["--url", "https://abc-8443s.gw.example", "--router", "https://router.example", "--submit", "--contact", "ops@example.org", "--datacenter", "US"])], { io, fetchImpl: stub.fetchImpl });
    expect(code).toBe(0);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].body).toMatchObject({ id: "demo-model", base_url: "https://abc-8443s.gw.example/v1", contact: "ops@example.org", datacenters: ["US"], tee: { kind: "tdx", attestation_url: "https://abc-8443s.gw.example/attest" } });
  });
});
