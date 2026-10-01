import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { normalizeBase, probe } from "../scripts/monitor.ts";

type Stub = { health?: [number, unknown]; ready?: [number, unknown]; escrow?: [number, unknown]; metrics?: [number, string] };
const servers: ReturnType<typeof Bun.serve>[] = [];
const seen: { method: string; path: string; auth: string | null }[] = [];

function stub(routes: Stub) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path, auth: req.headers.get("authorization") });
      const hit = path === "/health" ? routes.health : path === "/ready" ? routes.ready : path === "/api/v1/escrow" ? routes.escrow : path === "/ready/metrics" ? routes.metrics : undefined;
      if (!hit) return new Response("not found", { status: 404 });
      const response = typeof hit[1] === "string" ? new Response(hit[1], { status: hit[0] }) : Response.json(hit[1], { status: hit[0] });
      response.headers.set("connection", "close"); // Each ephemeral fixture owns its connection; never reuse one after stop(true).
      return response;
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); seen.length = 0; });

const healthy: Stub = {
  health: [200, { ok: true }],
  ready: [200, { ok: true, checks: { database: true, chain: true, "escrow-indexer": true } }],
  escrow: [200, { data: { enabled: true, address: "0x" + "a".repeat(40), tokens: [{ symbol: "NVDA", price_usd: 180.5 }, { symbol: "TSLA", price_usd: 250 }] } }],
  metrics: [200, "# HELP anyroute_ready x\nanyroute_ready 1\n"],
};

describe("read-only monitor probe", () => {
  test("all checks passing prints ok and exits 0", async () => {
    const { code, result } = await probe(stub(healthy));
    expect(code).toBe(0);
    expect(result).toMatchObject({ ok: true, failing: [], escrow: { enabled: true, tokens: 2, stale_prices: [] }, metrics: { reachable: true, ready: true } });
    expect(result.checks).toMatchObject({ health: true, ready: true, "ready.database": true, "ready.escrow-indexer": true, "escrow.prices": true });
    expect(seen.every((r) => r.method === "GET" && r.auth === null)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  });

  test("failing readiness checks and stale escrow prices exit 1 and are named", async () => {
    const { code, result } = await probe(stub({
      ...healthy,
      ready: [503, { ok: false, checks: { database: true, chain: false, backup_fresh: false } }],
      escrow: [200, { data: { enabled: true, tokens: [{ symbol: "NVDA", price_usd: null }, { symbol: "TSLA", price_usd: 250 }] } }],
      metrics: [200, "anyroute_ready 0\n"],
    }));
    expect(code).toBe(1);
    expect(result.failing).toEqual(["escrow.prices", "ready", "ready.backup_fresh", "ready.chain"]);
    expect(result.escrow).toEqual({ enabled: true, tokens: 2, stale_prices: ["NVDA"] });
    expect(result.metrics).toEqual({ reachable: true, ready: false });
  });

  test("an unreachable service exits 2; missing metrics are informational", async () => {
    const dead = stub(healthy);
    servers.pop()!.stop(true);
    expect((await probe(dead, { timeoutMs: 2_000 })).code).toBe(2);
    const { code, result } = await probe(stub({ ...healthy, metrics: undefined }));
    expect(code).toBe(0);
    expect(result.metrics).toEqual({ reachable: false });
  });

  test("escrow disabled is informational; a broken escrow endpoint fails", async () => {
    expect((await probe(stub({ ...healthy, escrow: [200, { data: { enabled: false } }] }))).result).toMatchObject({ ok: true, escrow: { enabled: false } });
    const broken = await probe(stub({ ...healthy, escrow: [500, { error: "x" }] }));
    expect(broken.code).toBe(1);
    expect(broken.result.failing).toEqual(["escrow"]);
  });

  test("the CLI prints one JSON line with the documented exit codes", async () => {
    const script = resolve(import.meta.dir, "../scripts/monitor.ts");
    // Async spawn: the stub server runs in this process and must keep serving.
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", "--no-env-file", script, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { code, stdout };
    };
    const ok = await run(stub(healthy));
    expect(ok.code).toBe(0);
    const lines = ok.stdout.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: true, failing: [] });
    expect((await run(stub({ ...healthy, ready: [503, { ok: false, checks: { chain: false } }] }))).code).toBe(1);
    expect((await run()).code).toBe(2);
    expect((await run("https://x.invalid", "--watch", "0")).code).toBe(2);
  });

  test("base URLs must be plain http(s) origins or paths", () => {
    expect(normalizeBase("https://router.example/")).toBe("https://router.example");
    expect(normalizeBase("https://user:pass@router.example")).toBeNull();
    expect(normalizeBase("https://router.example/?token=x")).toBeNull();
    expect(normalizeBase("file:///etc/passwd")).toBeNull();
  });
});
