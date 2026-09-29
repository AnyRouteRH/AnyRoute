import { describe, expect, test } from "bun:test";
import { QuotaManager } from "../src/quota.ts";

function make(policy: Partial<ConstructorParameters<typeof QuotaManager>[0]> = {}) {
  let t = 1_000_000;
  const q = new QuotaManager({ default: {}, global: {}, overrides: new Map(), ...policy }, () => t);
  return { q, advance: (ms: number) => (t += ms) };
}

describe("quota", () => {
  test("unlimited by default", () => {
    const { q } = make();
    for (let i = 0; i < 1000; i++) expect(q.admit("a").ok).toBe(true);
  });

  test("request bucket: burst, refusal with a retry hint, refill", () => {
    const { q, advance } = make({ default: { requestsPerMinute: 60, burst: 3 } });
    expect(q.admit("a").ok).toBe(true);
    expect(q.admit("a").ok).toBe(true);
    expect(q.admit("a").ok).toBe(true);
    const refused = q.admit("a");
    expect(refused).toEqual({ ok: false, retryAfterSec: 1, scope: "key" });
    advance(1000);
    expect(q.admit("a").ok).toBe(true);
    expect(q.admit("a").ok).toBe(false);
  });

  test("keys are independent and per-key overrides apply", () => {
    const { q } = make({ default: { requestsPerMinute: 60, burst: 1 }, overrides: new Map([["vip", { requestsPerMinute: 60, burst: 5 }]]) });
    expect(q.admit("a").ok).toBe(true);
    expect(q.admit("a").ok).toBe(false);
    expect(q.admit("b").ok).toBe(true);
    for (let i = 0; i < 5; i++) expect(q.admit("vip").ok).toBe(true);
    expect(q.admit("vip").ok).toBe(false);
  });

  test("token bucket admits while it has tokens and is charged after the fact", () => {
    const { q, advance } = make({ default: { tokensPerMinute: 600, tokenBurst: 100 } });
    expect(q.admit("a").ok).toBe(true);
    q.charge("a", 100);
    const refused = q.admit("a");
    expect(refused.ok).toBe(false);
    advance(1000); // 10 tokens/s
    expect(q.admit("a").ok).toBe(true);
  });

  test("a huge charge cannot push a key below minus its capacity", () => {
    const { q, advance } = make({ default: { tokensPerMinute: 600, tokenBurst: 100 } });
    q.charge("a", 1_000_000);
    advance(10_000); // -100 + 100 = 0
    expect(q.admit("a").ok).toBe(false);
    advance(1000);
    expect(q.admit("a").ok).toBe(true);
  });

  test("the global bucket limits all keys together, and a refusal charges nothing", () => {
    const { q, advance } = make({ global: { requestsPerMinute: 60, burst: 2 } });
    expect(q.admit("a").ok).toBe(true);
    expect(q.admit("b").ok).toBe(true);
    const r = q.admit("c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.scope).toBe("global");
    advance(1000);
    expect(q.admit("c").ok).toBe(true);
  });

  test("tracked keys are bounded", () => {
    let t = 0;
    const q = new QuotaManager({ default: { requestsPerMinute: 10 }, global: {}, overrides: new Map() }, () => t++, 3);
    for (const k of ["a", "b", "c", "d", "e"]) q.admit(k);
    expect(q.trackedKeys).toBe(3);
  });
});
