import { describe, expect, test } from "bun:test";
import { buildUpstreamHeaders, isForbiddenForwardHeader, isNetworkIdentifierHeader, pickResponseHeaders } from "../src/headers.ts";

describe("network identifier headers", () => {
  test("recognises the usual suspects", () => {
    for (const h of [
      "X-Forwarded-For",
      "x-forwarded-host",
      "Forwarded",
      "X-Real-IP",
      "CF-Connecting-IP",
      "cf-ipcountry",
      "cf-ray",
      "True-Client-IP",
      "Fastly-Client-IP",
      "X-Client-IP",
      "x-cluster-client-ip",
      "Via",
      "x-envoy-external-address",
      "x-amzn-trace-id",
      "fly-client-ip",
      "x-vercel-forwarded-for",
      "x-azure-clientip",
      "x-geo-city",
      "x-remote-addr",
    ]) {
      expect(isNetworkIdentifierHeader(h)).toBe(true);
    }
  });

  test("does not flag ordinary headers", () => {
    for (const h of ["content-type", "accept", "user-agent", "x-request-tag", "accept-language", "openai-organization", "x-stainless-lang"]) {
      expect(isNetworkIdentifierHeader(h)).toBe(false);
    }
  });

  test("credentials and hop-by-hop headers are never forwardable", () => {
    for (const h of ["authorization", "cookie", "host", "content-length", "transfer-encoding", "connection", "x-forwarded-for"]) {
      expect(isForbiddenForwardHeader(h)).toBe(true);
    }
    expect(isForbiddenForwardHeader("x-request-tag")).toBe(false);
  });
});

describe("upstream request headers", () => {
  const client = new Headers({
    authorization: "Bearer client-key",
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-forwarded-for": "203.0.113.9",
    "x-real-ip": "203.0.113.9",
    forwarded: "for=203.0.113.9",
    "cf-connecting-ip": "203.0.113.9",
    cookie: "session=abc",
    "user-agent": "curl/8.0 (Linux 203.0.113.9)",
    "x-request-tag": "batch-7",
    "x-other": "v",
  });

  test("only the allow-list is forwarded, with the sidecar's own credentials", () => {
    const h = buildUpstreamHeaders(client, { forwardHeaders: ["x-request-tag"], upstreamApiKey: "upstream-secret" });
    expect([...h.keys()].sort()).toEqual(["accept", "accept-encoding", "authorization", "content-type", "user-agent", "x-request-tag"]);
    expect(h.get("authorization")).toBe("Bearer upstream-secret");
    expect(h.get("user-agent")).toBe("anyroute-sidecar");
    expect(h.get("x-request-tag")).toBe("batch-7");
    expect(h.get("accept")).toBe("text/event-stream");
  });

  test("the client's credential is never passed on, even without an upstream key", () => {
    const h = buildUpstreamHeaders(client, { forwardHeaders: [] });
    expect(h.get("authorization")).toBeNull();
  });

  test("a forbidden name in forwardHeaders is ignored even if it slipped past the config check", () => {
    const h = buildUpstreamHeaders(client, { forwardHeaders: ["x-forwarded-for", "cookie", "authorization"] });
    expect(h.get("x-forwarded-for")).toBeNull();
    expect(h.get("cookie")).toBeNull();
    expect(h.get("authorization")).toBeNull();
  });

  test("only a small set of response headers comes back from the model server", () => {
    const out = pickResponseHeaders(new Headers({ "content-type": "application/json", server: "vllm", "set-cookie": "a=b", "x-upstream-secret": "x", "retry-after": "3" }));
    expect([...out.keys()].sort()).toEqual(["content-type", "retry-after"]);
  });
});
