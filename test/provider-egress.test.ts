import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { isPublicAddress, providerFetch } from "../src/providers/network.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

test("provider destination classification rejects private, metadata, mapped, and special-use addresses", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1",
    "fc00::1", "fe80::1", "2001:db8::1", "2002:0808:0808::1", "ff02::1",
  ]) expect(isPublicAddress(address)).toBe(false);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    expect(isPublicAddress(address)).toBe(true);
});

test("production rejects private and mixed DNS answers before opening a socket", async () => {
  const attempt = (addresses: { address: string; family: number }[]) => providerFetch("https://provider.example/v1", {}, {
    production: true,
    resolve: async () => addresses,
  });
  await expect(attempt([{ address: "127.0.0.1", family: 4 }])).rejects.toThrow("non-public");
  await expect(attempt([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }])).rejects.toThrow("non-public");
  await expect(providerFetch("http://8.8.8.8/", {}, { production: true })).rejects.toThrow("HTTPS");
});

test("DNS lookup stops promptly when the request is aborted", async () => {
  const controller = new AbortController();
  const request = providerFetch("https://provider.example/models", { signal: controller.signal }, {
    production: true,
    resolve: async () => new Promise(() => {}),
  });
  controller.abort(new DOMException("fixture abort", "AbortError"));
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("development mock loopback is explicitly available outside production only", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ fixture: true }) });
  servers.push(server);
  const url = `http://codex-pinned-fixture.invalid:${server.port}/models`;
  const response = await providerFetch(url, { redirect: "error" }, {
    production: false,
    allowDevelopmentMockLoopback: true,
    allowDevelopmentLoopbackHostnames: ["codex-pinned-fixture.invalid"],
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ fixture: true });
  await expect(providerFetch(url, {}, { production: true, allowDevelopmentMockLoopback: true, allowDevelopmentLoopbackHostnames: ["codex-pinned-fixture.invalid"], resolve: async () => [{ address: "127.0.0.1", family: 4 }] })).rejects.toThrow("HTTPS");
  await expect(providerFetch(url, {}, { production: false, allowDevelopmentLoopbackHostnames: ["codex-pinned-fixture.invalid"], resolve: async () => [{ address: "127.0.0.1", family: 4 }] })).rejects.toThrow("non-public");
});

test("provider response compression is negotiated as identity and unexpected compression fails closed", async () => {
  let acceptEncoding = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      acceptEncoding = request.headers.get("accept-encoding") ?? "";
      return new Response(gzipSync(Buffer.from('{"ok":true}')), { headers: { "content-encoding": "gzip", "content-type": "application/json" } });
    },
  });
  servers.push(server);
  await expect(providerFetch(`http://127.0.0.1:${server.port}/models`, {}, { production: false, allowDevelopmentMockLoopback: true })).rejects.toThrow("despite Accept-Encoding: identity");
  expect(acceptEncoding).toBe("identity");
});

test("provider redirects are returned as responses and never followed", async () => {
  let destinationHits = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { destinationHits++; return new Response("unexpected"); } });
  servers.push(destination);
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${destination.port}/secret`) });
  servers.push(source);
  const response = await providerFetch(`http://127.0.0.1:${source.port}/models`, { redirect: "error" }, { production: false, allowDevelopmentMockLoopback: true });
  expect(response.status).toBe(302);
  await response.body?.cancel();
  expect(destinationHits).toBe(0);
});
