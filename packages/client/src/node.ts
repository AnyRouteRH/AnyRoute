import type { AttestFetcher } from "./attestation.js";

// Node and Bun only. A sidecar serves its own self-signed certificate, which ordinary fetch() refuses. This fetcher
// opens one TLS connection without a certificate authority, asks for the document on that same connection, and hands
// back the certificate the server presented, so the caller can check it against the quote (evaluateAttestation does:
// the certificate must carry the attestation name and the TLS key the quote commits to). Connecting without
// validation is safe only because that check follows. Never use this fetcher for anything but /attest.

const MAX_BYTES = 2 * 1024 * 1024;

function decodeChunked(body: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const text = new TextDecoder("latin1");
  let at = 0;
  for (;;) {
    let end = at;
    while (end + 1 < body.length && !(body[end] === 13 && body[end + 1] === 10)) end++;
    const size = parseInt(text.decode(body.subarray(at, end)).split(";")[0].trim(), 16);
    if (!Number.isFinite(size)) throw new Error("malformed chunked response");
    if (size === 0) return Buffer.concat(parts);
    parts.push(body.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
    if (at > body.length) throw new Error("truncated chunked response");
  }
}

export function nodeAttestFetcher(o: { timeoutMs?: number } = {}): AttestFetcher {
  return async (url, init) => {
    const tls = (await import("node:tls")) as typeof import("node:tls");
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("the provider's attestation endpoint must be https");
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      let certificate: Uint8Array | null = null;
      const socket = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: /^[\d.:]+$/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false });
      const timer = setTimeout(() => socket.destroy(new Error("timed out")), o.timeoutMs ?? 20_000);
      const fail = (e: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(e);
      };
      init?.signal?.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
      socket.on("secureConnect", () => {
        const raw = socket.getPeerCertificate(true)?.raw;
        certificate = raw ? new Uint8Array(raw) : null;
        socket.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: anyroute-client\r\n\r\n`);
      });
      socket.on("data", (c: Uint8Array) => {
        size += c.length;
        if (size > MAX_BYTES) return fail(new Error("response too large"));
        chunks.push(c);
      });
      socket.on("error", fail);
      socket.on("close", () => {
        clearTimeout(timer);
        try {
          const all = Buffer.concat(chunks);
          const split = all.indexOf("\r\n\r\n");
          if (split < 0) throw new Error("no HTTP response");
          const head = all.subarray(0, split).toString("latin1").split("\r\n");
          const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0])?.[1]);
          if (!(status >= 200 && status < 300)) throw new Error(`GET ${url} failed with ${status}`);
          const headers = head.slice(1).map((l) => l.toLowerCase());
          let body: Uint8Array = all.subarray(split + 4);
          if (headers.some((l) => l.startsWith("transfer-encoding:") && l.includes("chunked"))) body = decodeChunked(body);
          resolve({ json: JSON.parse(new TextDecoder().decode(body)), certificate });
        } catch (e) {
          reject(e);
        }
      });
    });
  };
}
