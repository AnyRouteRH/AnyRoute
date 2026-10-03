import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CAPABILITIES, FIXTURE, check, clauses, drift, judge, liveSnapshot, type Snapshot } from "../scripts/docs-claims-check.ts";

const root = resolve(import.meta.dir, "..");
const fixture = JSON.parse(readFileSync(resolve(root, FIXTURE), "utf8")) as Snapshot;
const off: Snapshot = { data: { per_call: { configured: false, x402: { configured: false } }, agreements: { enabled: true, rulings: { enabled: false } } } };
const at = (text: string, implicit = false) => judge({ file: "doc.md", line: 1, text, implicit }, off);

describe("docs claims check", () => {
  test("the repository docs agree with the production status fixture", async () => {
    const { findings, clauses: count } = await check(fixture);
    expect(count).toBeGreaterThan(1000);
    expect(findings.filter((f) => f.level === "fail").map((f) => `${f.clause.file}:${f.clause.line} ${f.capability.id}: ${f.clause.text}`)).toEqual([]);
  });

  test("every capability names the status field or config flag that decides it", () => {
    for (const c of CAPABILITIES) expect(c.field.length).toBeGreaterThan(3);
    expect(CAPABILITIES.find((c) => c.id === "x402")!.field).toBe("per_call.x402.configured");
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(CAPABILITIES.length);
  });

  test("a live claim fails when status says off, and a qualified one passes", () => {
    expect(at("x402 per-call payments are live at anyroute.tech.").map((f) => f.capability.id)).toEqual(["x402", "per-call"]);
    expect(at("Automatic jury rulings are switched on.").map((f) => [f.level, f.capability.id])).toEqual([["fail", "rulings"]]);
    expect(at("x402 per-call payments are built and switch on when the router is configured for them.")).toEqual([]);
    expect(at("Automatic jury rulings are not switched on yet.")).toEqual([]);
    expect(at("Agreements between agents are live.")).toEqual([]);
  });

  test("a capability table row or changelog entry lists a feature as on without saying live", () => {
    expect(at("Chat and embeddings, including x402 per-call payments.", true).map((f) => f.capability.id)).toEqual(["x402", "per-call"]);
    expect(at("Chat and embeddings, including x402 per-call payments.", false)).toEqual([]);
  });

  test("the x402 facilitator and x402 tools answer to their own status fields", () => {
    expect(at("The hosted x402 facilitator is live.").map((f) => [f.capability.id, f.capability.field])).toEqual([["facilitator", "facilitator.enabled"]]);
    expect(at("Pay x402 tools from your balance.", true).map((f) => [f.capability.id, f.capability.field])).toEqual([["tools", "tools.ready"]]);
  });

  test("a changelog entry that says it is not on yet lists nothing as on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-claims-"));
    mkdirSync(join(dir, "web/lib"), { recursive: true });
    const entry = (id: string, summary: string) => ({ id, date: "2026-10-03", title: "Pay per call with x402", summary, links: [], tags: ["build"] });
    writeFileSync(join(dir, "web/lib/changelog-data.js"), `export default ${JSON.stringify([
      entry("qualified", "Built, but off until an operator sets X402_PAY_TO."),
      entry("listed", "Agents pay in USDG."),
    ], null, 2)};\n`);
    const { findings } = await check(off, [{ path: "web/lib/changelog-data.js", kind: "changelog" }], dir);
    expect([...new Set(findings.map((f) => f.clause.file))]).toEqual(["web/lib/changelog-data.js#listed"]);
  });

  test("agreements and rulings follow the status agreements section, with the job list as the older signal", () => {
    const claim = { file: "doc.md", line: 1, text: "Automatic jury rulings are switched on.", implicit: false };
    const live = { ...claim, text: "Agreements between agents are live." };
    const older: Snapshot = { data: { jobs: [{ name: "agreement-indexer" }] } };
    expect(judge(claim, { data: { agreements: { enabled: true, rulings: { enabled: true, source: "jury-worker-heartbeat" } } } })).toEqual([]);
    expect(judge(claim, older).map((f) => [f.capability.id, f.value])).toEqual([["rulings", undefined]]);
    expect(judge(live, older)).toEqual([]);
    expect(judge(live, { data: { agreements: { enabled: false }, jobs: [{ name: "agreement-indexer" }] } }).map((f) => f.capability.id)).toEqual(["agreements"]);
  });

  test("calling an on feature off is a warning, not a failure", () => {
    expect(at("The agreement contracts are not switched on yet.").map((f) => [f.level, f.capability.id])).toEqual([["warn", "agreements"]]);
  });

  test("clauses split sentences, semicolons and \", but\"", () => {
    expect(clauses("Sealed hosting is available, but none is registered. Payouts are off; burns are off.")).toEqual(["Sealed hosting is available", "none is registered.", "Payouts are off", "burns are off."]);
  });

  test("README table rows, reference links and code spans are read as the check expects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-claims-"));
    mkdirSync(join(dir, "web/components"), { recursive: true });
    writeFileSync(join(dir, "README.md"), [
      "| Capability | What it gives you |", "| :--- | :--- |",
      "| **One API** | Chat, including [x402 per-call payments](https://example.invalid/#x402). |",
      "| **Agreements** | Deployed. Shows `per_call.x402.configured`. [Agreements and jury trust](https://example.invalid/#agreements). |",
      "```", "x402 is live", "```",
    ].join("\n"));
    const { findings } = await check(off, [{ path: "README.md", kind: "markdown" }], dir);
    expect(findings.map((f) => `${f.clause.line} ${f.capability.id}`)).toEqual(["3 x402", "3 per-call"]);
  });

  test("live mode reads data from GET /api/v1/status and reports drift from the fixture", async () => {
    const fetcher = (async (url: URL) => {
      expect(String(url)).toBe("https://router.example/api/v1/status");
      return new Response(JSON.stringify({ data: { ...fixture.data, per_call: { configured: true, x402: { configured: true } } } }));
    }) as unknown as typeof fetch;
    const live = await liveSnapshot("https://router.example", fetcher);
    expect(drift(fixture, { ...live, config: fixture.config }).map((d) => d.capability.id).sort()).toEqual(["per-call", "x402"]);
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(liveSnapshot("https://router.example", failing)).rejects.toThrow("503");
  });
});
