import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { canonicalJson } from "../src/lib/util.ts";
import { auditPath, mth } from "./measurement-fixtures.ts";

// An in-memory Sigstore Rekor v1, enough of its HTTP API for the measurement tests: submit a hashedrekord entry, read an
// entry with its inclusion proof, signed checkpoint and signed entry timestamp, and look entries up by artifact hash. It
// signs with a key of its own. Entries have the shape of the real log's (see test/fixtures/rekor for a captured one), and
// nothing here talks to the network.

export const REKOR_ORIGIN = "rekor.test - 1234";
const TREE_PREFIX = "24296fb24b8ad77a";
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

type Stored = { uuid: string; body: Buffer; hash: string; keyContent: string; integratedTime: number };

export class MockRekor {
  readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly publicKeyPem = this.keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  readonly logId = sha(this.keys.publicKey.export({ type: "spki", format: "der" })).toString("hex");
  readonly calls: { method: string; url: string; body?: any }[] = [];
  private entries: Stored[] = [];
  /** Pretend the log has not integrated new entries yet: reads return the entry without an inclusion proof. */
  withholdProofs = false;
  /** Fail every request with this status. */
  outage: number | null = null;
  clock = 1_790_000_000;

  constructor(readonly baseUrl = "https://rekor.example.test", preload = 6) {
    for (let i = 0; i < preload; i++) this.append(Buffer.from(`preloaded-entry-${i}`), `pre-${i}`, "pre");
  }

  private append(body: Buffer, hash: string, keyContent: string): Stored {
    const uuid = TREE_PREFIX + sha(Buffer.concat([Buffer.from([0]), body])).toString("hex");
    const e = { uuid, body, hash, keyContent, integratedTime: this.clock++ };
    this.entries.push(e);
    return e;
  }

  get size() {
    return this.entries.length;
  }

  /** Append an entry with this body (an object, stored in canonical JSON, or a string as is) and return its uuid. */
  add(body: unknown): string {
    const bytes = Buffer.from(typeof body === "string" ? body : canonicalJson(body));
    const spec = (body as any)?.spec;
    return this.append(bytes, String(spec?.data?.hash?.value ?? "none"), String(spec?.signature?.publicKey?.content ?? "none")).uuid;
  }

  /** Change what an entry's body says, keeping its uuid: a log that lies about an entry. */
  replaceBody(uuid: string, body: object) {
    const e = this.entries.find((x) => x.uuid === uuid)!;
    e.body = Buffer.from(canonicalJson(body));
  }
  bodyOf(uuid: string): any {
    return JSON.parse(this.entries.find((x) => x.uuid === uuid)!.body.toString());
  }
  uuids(): string[] {
    return this.entries.map((e) => e.uuid);
  }

  /** The entry as GET /api/v1/log/entries/{uuid} returns it. */
  entryJson(uuid: string, opts: { treeSize?: number } = {}): Record<string, unknown> | null {
    const index = this.entries.findIndex((e) => e.uuid === uuid);
    if (index < 0) return null;
    const e = this.entries[index]!;
    const size = opts.treeSize ?? this.entries.length;
    const data = this.entries.slice(0, size).map((x) => x.body);
    const root = mth(data);
    const logIndex = index + 1000;
    const body = e.body.toString("base64");
    const set = cryptoSign("sha256", Buffer.from(canonicalJson({ body, integratedTime: e.integratedTime, logID: this.logId, logIndex })), this.keys.privateKey).toString("base64");
    const note = `${REKOR_ORIGIN}\n${size}\n${root.toString("base64")}\n`;
    const sig = cryptoSign("sha256", Buffer.from(note), this.keys.privateKey);
    const checkpoint = `${note}\n— rekor.test ${Buffer.concat([Buffer.from("01020304", "hex"), sig]).toString("base64")}\n`;
    return {
      [uuid]: {
        body,
        integratedTime: e.integratedTime,
        logID: this.logId,
        logIndex,
        verification: {
          signedEntryTimestamp: set,
          ...(this.withholdProofs ? {} : { inclusionProof: { logIndex: index, rootHash: root.toString("hex"), treeSize: size, hashes: auditPath(index, data).map((h) => h.toString("hex")), checkpoint } }),
        },
      },
    };
  }

  fetch = (async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const u = String(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, url: u, body });
    const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
    if (this.outage) return json({ code: this.outage, message: "unavailable" }, this.outage);
    if (!u.startsWith(this.baseUrl)) return json({ message: "unknown host" }, 502);
    const path = u.slice(this.baseUrl.length);

    if (method === "POST" && path === "/api/v1/log/entries") {
      const v = body?.spec;
      const okShape = body?.kind === "hashedrekord" && body?.apiVersion === "0.0.1" && v?.data?.hash?.algorithm === "sha256" && /^[0-9a-f]{64}$/.test(v?.data?.hash?.value ?? "") && typeof v?.signature?.content === "string" && typeof v?.signature?.publicKey?.content === "string";
      if (!okShape) return json({ code: 400, message: "validation failure" }, 400);
      // Rekor stores the canonical form of what it was given.
      const canonicalBody = { apiVersion: "0.0.1", kind: "hashedrekord", spec: { data: { hash: { algorithm: "sha256", value: v.data.hash.value } }, signature: { content: v.signature.content, publicKey: { content: v.signature.publicKey.content } } } };
      const bytes = Buffer.from(canonicalJson(canonicalBody));
      const uuid = TREE_PREFIX + sha(Buffer.concat([Buffer.from([0]), bytes])).toString("hex");
      const dup = this.entries.find((e) => e.hash === v.data.hash.value && e.keyContent === v.signature.publicKey.content);
      if (dup) return json({ code: 409, message: `an equivalent entry already exists in the transparency log with UUID ${dup.uuid}` }, 409, { location: `/api/v1/log/entries/${dup.uuid}` });
      const e = this.append(bytes, v.data.hash.value, v.signature.publicKey.content);
      return json(this.entryJson(e.uuid), 201, { location: `/api/v1/log/entries/${e.uuid}` });
    }
    if (method === "POST" && path === "/api/v1/index/retrieve") {
      const h = String(body?.hash ?? "").replace(/^sha256:/, "");
      return json(this.entries.filter((e) => e.hash === h).map((e) => e.uuid));
    }
    const m = /^\/api\/v1\/log\/entries\/([0-9a-f]+)$/.exec(path);
    if (method === "GET" && m) {
      const e = this.entryJson(m[1]!);
      return e ? json(e) : json({ code: 404, message: "not found" }, 404);
    }
    return json({ code: 404, message: "no such route" }, 404);
  }) as unknown as typeof fetch;
}

export const pemOf = (k: KeyObject) => k.export({ type: "spki", format: "pem" }).toString();
