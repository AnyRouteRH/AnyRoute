import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { recoverAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startRouter, MODELS, type Harness } from "./helpers.ts";
import { cborEncode, type CborValue } from "../src/receipts/cbor.ts";
import { teamAudit } from "../src/db/schema.ts";
import { chainHash, exportCsv, exportJsonl, GENESIS, hourlyRoots, verifyChain, type ChainedEntry } from "../src/teams/audit.ts";
import { verifyAssertion, verifyRegistration, WebAuthnError } from "../src/teams/webauthn.ts";
import { roleAllowed } from "../src/api/auth.ts";
// The offline verifier auditors run; it shares no code with the router.
import { verifyExport } from "../scripts/verify-audit.mjs";

type Auth = Record<string, string>;
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** A software passkey authenticator (ES256 or Ed25519) that answers navigator.credentials.create/get the way a browser does. */
function softAuthenticator(alg: "ES256" | "EdDSA" = "ES256") {
  const { publicKey, privateKey } = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y?: string };
  const cose: CborValue =
    alg === "ES256"
      ? new Map<CborValue, CborValue>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]])
      : new Map<CborValue, CborValue>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, "base64url")]]);
  const credId = randomBytes(32);
  let counter = 0;
  const authData = (rpId: string, flags: number, withCred: boolean) =>
    Buffer.concat([sha(rpId), Buffer.of(flags), u32(counter), ...(withCred ? [Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(cborEncode(cose))] : [])]);
  const clientData = (type: string, challenge: string, origin: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64u(credId),
    create(o: { challenge: string; rp: { id: string } }, origin: string, tweak: { rpId?: string; flags?: number } = {}) {
      const att = cborEncode(new Map<CborValue, CborValue>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(tweak.rpId ?? o.rp.id, tweak.flags ?? 0x45, true)]]));
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(clientData("webauthn.create", o.challenge, origin)), attestationObject: b64u(att) } };
    },
    get(o: { challenge: string; rpId: string }, origin: string, tweak: { key?: KeyObject; counter?: number } = {}) {
      counter = tweak.counter ?? counter + 1;
      const ad = authData(o.rpId, 0x05, false);
      const cd = clientData("webauthn.get", o.challenge, origin);
      const sig = sign(alg === "ES256" ? "sha256" : null, Buffer.concat([ad, sha(cd)]), tweak.key ?? privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null } };
    },
  };
}

describe("passkeys (WebAuthn, pure)", () => {
  const policy = { rpId: "anyroute.test", origins: ["https://anyroute.test"], challenge: b64u(randomBytes(32)) };
  for (const alg of ["ES256", "EdDSA"] as const) {
    test(`${alg}: a registration is accepted and its assertion verifies; the counter must move forward`, () => {
      const a = softAuthenticator(alg);
      const reg = verifyRegistration(a.create({ challenge: policy.challenge, rp: { id: policy.rpId } }, policy.origins[0]).response, policy);
      expect(reg.credentialId).toBe(a.id);
      expect(reg.alg).toBe(alg === "ES256" ? -7 : -8);
      const challenge = b64u(randomBytes(32));
      const got = a.get({ challenge, rpId: policy.rpId }, policy.origins[0]);
      expect(verifyAssertion(got.response, { ...policy, challenge }, reg).signCount).toBe(1);
      // The same assertion against a stored counter that is already at 1 is a replay or a clone.
      expect(() => verifyAssertion(got.response, { ...policy, challenge }, { ...reg, signCount: 1 })).toThrow(WebAuthnError);
    });
  }

  test("wrong challenge, origin, relying party, missing user presence and a forged signature are all rejected", () => {
    const a = softAuthenticator();
    const o = { challenge: policy.challenge, rp: { id: policy.rpId } };
    expect(() => verifyRegistration(a.create(o, policy.origins[0]).response, { ...policy, challenge: b64u(randomBytes(32)) })).toThrow(/challenge/);
    expect(() => verifyRegistration(a.create(o, "https://evil.test").response, policy)).toThrow(/Origin/);
    expect(() => verifyRegistration(a.create(o, policy.origins[0], { rpId: "evil.test" }).response, policy)).toThrow(/relying party/);
    expect(() => verifyRegistration(a.create(o, policy.origins[0], { flags: 0x44 }).response, policy)).toThrow(/UP flag/);
    const reg = verifyRegistration(a.create(o, policy.origins[0]).response, policy);
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(() => verifyAssertion(a.get({ challenge: policy.challenge, rpId: policy.rpId }, policy.origins[0], { key: other }).response, policy, reg)).toThrow(/signature/);
    // A registration response is not an assertion.
    const created = a.create(o, policy.origins[0]).response;
    expect(() => verifyAssertion({ clientDataJSON: created.clientDataJSON, authenticatorData: b64u(Buffer.alloc(37)), signature: "" }, policy, reg)).toThrow(/webauthn.get/);
  });
});

describe("roles (pure)", () => {
  test("dev reads and calls like member or viewer; agent only calls; neither manages", () => {
    const CALL = ["owner", "admin", "member"] as const;
    const READ = ["owner", "admin", "member", "viewer"] as const;
    const MANAGE = ["owner", "admin"] as const;
    expect([roleAllowed("dev", [...CALL]), roleAllowed("dev", [...READ]), roleAllowed("dev", [...MANAGE])]).toEqual([true, true, false]);
    expect([roleAllowed("agent", [...CALL]), roleAllowed("agent", [...READ]), roleAllowed("agent", [...MANAGE])]).toEqual([true, false, false]);
    expect([roleAllowed("viewer", [...CALL]), roleAllowed("viewer", [...READ]), roleAllowed("viewer", [...MANAGE])]).toEqual([false, true, false]);
  });
});

describe("audit chain (pure)", () => {
  const team = "team_x";
  const make = (n: number) => {
    const out: ChainedEntry[] = [];
    let prev = GENESIS;
    for (let i = 1; i <= n; i++) {
      const e = { team, seq: i, at: new Date(Date.UTC(2026, 8, 30, 12 + Math.floor(i / 3), i)).toISOString(), actor: "key:0123456789abcdef", action: "key.update", target: `k${i}`, detail: { fields: ["budget"], limit_usd: i, note: 'a,"b"\nc' } };
      const hash = chainHash(prev, e);
      out.push({ ...e, prev_hash: prev, hash });
      prev = hash;
    }
    return out;
  };

  test("h_i = sha256(h_{i-1} || canonical(entry)); the router and the offline script agree on JSONL and CSV", () => {
    const entries = make(7);
    const head = verifyChain(entries);
    expect(head).toEqual({ ok: true, head: entries[6].hash, entries: 7 });
    expect(hourlyRoots(entries).map((r) => r.count)).toEqual([2, 3, 2]);
    for (const text of [exportJsonl(team, entries), exportCsv(entries)]) expect(verifyExport(text)).toMatchObject({ ok: true, entries: 7, head: entries[6].hash, team });
    expect(verifyExport(exportJsonl(team, entries), { head: entries[6].hash }).ok).toBe(true);
    expect(verifyExport(exportJsonl(team, entries.slice(0, 6)), { head: entries[6].hash })).toMatchObject({ ok: false });
  });

  test("any edit, deletion, reordering or truncation is detected, by the router and by the script", () => {
    const entries = make(6);
    const edited = entries.map((e) => (e.seq === 3 ? { ...e, detail: { ...e.detail, limit_usd: 999 } } : e));
    expect(verifyChain(edited)).toMatchObject({ ok: false, seq: 3 });
    expect(verifyExport(exportCsv(edited))).toMatchObject({ ok: false, seq: 3 });
    const rehashed = edited.map((e) => (e.seq === 3 ? { ...e, hash: chainHash(e.prev_hash, e) } : e)); // fixing one hash breaks the next link
    expect(verifyExport(exportCsv(rehashed))).toMatchObject({ ok: false, seq: 4 });
    expect(verifyExport(exportCsv(entries.filter((e) => e.seq !== 4)))).toMatchObject({ ok: false, seq: 5 });
    expect(verifyExport(exportCsv([entries[1], entries[0], ...entries.slice(2)]))).toMatchObject({ ok: false });
    const jsonl = exportJsonl("team_x", entries).split("\n");
    expect(verifyExport(jsonl.filter((_, i) => i !== 6).join("\n"))).toMatchObject({ ok: false }); // last entry dropped: header count and head disagree
    const badRoot = jsonl.map((l) => (l.includes('"type":"root"') ? l.replace(/"root":"[0-9a-f]{4}/, '"root":"0000') : l)).join("\n");
    expect(verifyExport(badRoot)).toMatchObject({ ok: false, error: expect.stringContaining("hourly root") });
  });
});

describe("organisations (API)", () => {
  let h: Harness;
  let root: Awaited<ReturnType<Harness["fundedKey"]>>;
  let teamId: string;
  const as: Record<string, Auth> = {};
  const hashes: Record<string, string> = {};
  const origin = "http://127.0.0.1:8787";
  const call = async (path: string, auth: Auth | undefined, method = "GET", json?: unknown) => {
    const r = await h.request(path, { method, headers: auth, json });
    return { status: r.status, body: (await r.json().catch(() => null)) as any, r };
  };
  const newSub = async (team: string, role: string, extra: Record<string, unknown> = {}) => {
    const r = await call("/api/v1/keys", root.auth, "POST", { name: role, team, role, ...extra });
    expect(r.status).toBe(201);
    return { auth: { authorization: `Bearer ${r.body.key}` }, hash: r.body.data.hash as string };
  };

  beforeAll(async () => {
    h = await startRouter();
    root = await h.fundedKey(20n);
    const t = await call("/api/v1/teams", root.auth, "POST", { name: "anon-org" });
    expect(t.status).toBe(201);
    expect(t.body.data.owner).toMatchObject({ kind: "account", address: null });
    teamId = t.body.data.id;
    as.owner = root.auth;
    for (const role of ["admin", "dev", "viewer", "agent"]) {
      const k = await newSub(teamId, role);
      as[role] = k.auth;
      hashes[role] = k.hash;
    }
  });
  afterAll(() => h.close());

  test("role matrix: every org-scoped route answers each role as documented", async () => {
    const other = await call("/api/v1/keys", root.auth, "POST", { name: "spare" });
    const target = other.body.data.hash;
    // [label, request, expected status for owner, admin, dev, viewer, agent]
    const matrix: [string, (a: Auth) => Promise<{ status: number }>, number[]][] = [
      ["GET team", (a) => call(`/api/v1/teams/${teamId}`, a), [200, 200, 200, 200, 403]],
      ["GET teams", (a) => call(`/api/v1/teams`, a), [200, 200, 200, 200, 403]],
      ["PATCH team", (a) => call(`/api/v1/teams/${teamId}`, a, "PATCH", { name: "anon-org" }), [200, 200, 403, 403, 403]],
      ["POST invite", (a) => call(`/api/v1/teams/${teamId}/invites`, a, "POST", { role: "viewer" }), [201, 201, 403, 403, 403]],
      ["GET audit", (a) => call(`/api/v1/teams/${teamId}/audit`, a), [200, 200, 200, 200, 403]],
      ["GET audit roots", (a) => call(`/api/v1/teams/${teamId}/audit/roots`, a), [200, 200, 200, 200, 403]],
      ["GET audit export", (a) => h.request(`/api/v1/teams/${teamId}/audit/export?format=csv`, { headers: a }), [200, 200, 200, 200, 403]],
      ["POST owner challenge", (a) => call(`/api/v1/teams/${teamId}/owner/challenge`, a, "POST", { address: privateKeyToAccount(generatePrivateKey()).address }), [200, 403, 403, 403, 403]],
      ["PUT member", (a) => call(`/api/v1/teams/${teamId}/members/${target}`, a, "PUT", { role: "viewer" }), [200, 200, 403, 403, 403]],
      ["POST key", (a) => call(`/api/v1/keys`, a, "POST", { name: "made", role: "agent", team: teamId }), [201, 201, 201, 403, 403]],
      ["GET keys", (a) => call(`/api/v1/keys`, a), [200, 200, 200, 200, 403]],
      ["PATCH key", (a) => call(`/api/v1/keys/${hashes.agent}`, a, "PATCH", { rpm: 50 }), [200, 200, 403, 403, 403]],
      ["GET presets", (a) => call(`/api/v1/presets`, a), [200, 200, 200, 200, 403]],
      ["chat", (a) => call(`/api/v1/chat/completions`, a, "POST", { model: MODELS.llama.slug, messages: [{ role: "user", content: "hi" }] }), [200, 200, 200, 403, 200]],
    ];
    const roles = ["owner", "admin", "dev", "viewer", "agent"];
    const got: Record<string, number[]> = {};
    const want: Record<string, number[]> = {};
    for (const [label, req, expected] of matrix) {
      got[label] = [];
      want[label] = expected;
      for (const role of roles) got[label].push((await req(as[role])).status);
    }
    expect(got).toEqual(want);
    // An admin cannot invite an admin (at its own rank); only the owner can.
    expect((await call(`/api/v1/teams/${teamId}/invites`, as.admin, "POST", { role: "admin" })).status).toBe(403);
    expect((await call(`/api/v1/teams/${teamId}/invites`, as.owner, "POST", { role: "admin" })).status).toBe(201);
    // A key of another team is not in this team at all.
    const t2 = (await call("/api/v1/teams", root.auth, "POST", { name: "other" })).body.data.id;
    const outsider = await newSub(t2, "admin");
    expect((await call(`/api/v1/teams/${teamId}`, outsider.auth)).status).toBe(404);
    expect((await call(`/api/v1/teams/${teamId}/audit`, outsider.auth)).status).toBe(404);
  });

  test("org budget: every key needs a limit and all limits fit in the budget; devs create keys only within it", async () => {
    const t = (await call("/api/v1/teams", root.auth, "POST", { name: "budgeted", budget_usd: 5 })).body.data;
    expect(t).toMatchObject({ budget_usd: 5, allocated_usd: 0 });
    expect((await call("/api/v1/keys", root.auth, "POST", { team: t.id, role: "dev" })).body.error.type).toBe("org_budget_limit_required");
    const dev = await newSub(t.id, "dev", { limit: 1 });
    const made = await call("/api/v1/keys", dev.auth, "POST", { name: "job", limit: 3, role: "agent" });
    expect(made.status).toBe(201);
    expect(made.body.data.team).toBe(t.id);
    const over = await call("/api/v1/keys", dev.auth, "POST", { name: "job2", limit: 2 });
    expect([over.status, over.body.error.type]).toEqual([409, "org_budget_exceeded"]);
    expect((await call("/api/v1/keys", dev.auth, "POST", { name: "admin?", limit: 0.5, role: "admin" })).status).toBe(403);
    expect((await call("/api/v1/keys", dev.auth, "POST", { name: "elsewhere", limit: 0.5, team: teamId })).status).toBe(403);
    // Raising a limit past the budget is refused too; the budget cannot drop below what is given out.
    expect((await call(`/api/v1/keys/${made.body.data.hash}`, root.auth, "PATCH", { limit: 4.5 })).body.error.type).toBe("org_budget_exceeded");
    expect((await call(`/api/v1/teams/${t.id}`, root.auth, "PATCH", { budget_usd: 3 })).body.error.type).toBe("org_budget_exceeded");
    expect((await call(`/api/v1/teams/${t.id}`, root.auth)).body.data.allocated_usd).toBe(4);
    // Moving an unlimited key into the team would bypass the budget, so it is refused.
    const loose = (await call("/api/v1/keys", root.auth, "POST", { name: "loose" })).body.data.hash;
    expect((await call(`/api/v1/teams/${t.id}/members/${loose}`, root.auth, "PUT", { role: "dev" })).body.error.type).toBe("org_budget_limit_required");
    // A team whose keys have no limit cannot get a budget until they do.
    expect((await call(`/api/v1/teams/${teamId}`, root.auth, "PATCH", { budget_usd: 100 })).body.error.type).toBe("org_budget_unlimited_keys");
  });

  test("a member joins with a passkey, signs in with an assertion, and loses access when revoked", async () => {
    const inv = await call(`/api/v1/teams/${teamId}/invites`, as.admin, "POST", { role: "dev", method: "passkey" });
    const invite = inv.body.data.invite as string;
    expect(invite).toMatch(/^ar-inv-[0-9a-f]{48}$/);
    // Only the invite's SHA-256 is stored.
    expect(JSON.stringify(await h.ctx.db.execute(sql`SELECT key, value FROM kv WHERE key LIKE 'team-invite:%'`))).not.toContain(invite);
    const ch = await call("/api/v1/teams/join/challenge", undefined, "POST", { invite, method: "passkey" });
    expect(ch.body.data.publicKey).toMatchObject({ rp: { id: "127.0.0.1" }, attestation: "none", authenticatorSelection: { residentKey: "required" } });
    expect(ch.body.data.publicKey.user.displayName).not.toContain("@");
    const a = softAuthenticator();
    // A wallet join with a passkey invite, or an answer to another challenge, is refused.
    expect((await call("/api/v1/teams/join/challenge", undefined, "POST", { invite, method: "wallet", address: privateKeyToAccount(generatePrivateKey()).address })).status).toBe(400);
    const wrongOrigin = await call("/api/v1/teams/join", undefined, "POST", { invite, challenge_id: ch.body.data.challenge_id, passkey: a.create(ch.body.data.publicKey, "https://evil.test") });
    expect([wrongOrigin.status, wrongOrigin.body.error.type]).toEqual([401, "invalid_passkey"]);
    const joined = await call("/api/v1/teams/join", undefined, "POST", { invite, challenge_id: ch.body.data.challenge_id, passkey: a.create(ch.body.data.publicKey, origin) });
    expect(joined.status).toBe(201);
    expect(joined.body.data.principal).toMatchObject({ kind: "passkey", role: "dev" });
    expect(joined.body.data.key).toMatchObject({ team: teamId, limit: 0 });
    const pid = joined.body.data.principal.id;
    // The invite and the challenge worked once.
    expect((await call("/api/v1/teams/join", undefined, "POST", { invite, challenge_id: ch.body.data.challenge_id, passkey: a.create(ch.body.data.publicKey, origin) })).status).toBe(401);
    const memberAuth = { authorization: `Bearer ${joined.body.key}` };
    expect((await call(`/api/v1/teams/${teamId}`, memberAuth)).body.data.your_role).toBe("dev");

    const signIn = async (tweak: Parameters<ReturnType<typeof softAuthenticator>["get"]>[2] = {}, from = origin) => {
      const c = await call(`/api/v1/teams/${teamId}/sign-in/challenge`, undefined, "POST", { method: "passkey" });
      expect(c.body.data.publicKey.allowCredentials).toEqual([]); // discoverable passkeys: the team's credentials are never listed
      return call(`/api/v1/teams/${teamId}/sign-in`, undefined, "POST", { challenge_id: c.body.data.challenge_id, passkey: a.get(c.body.data.publicKey, from, tweak) });
    };
    const ok = await signIn();
    expect(ok.status).toBe(201);
    expect(ok.body.data.principal.id).toBe(pid);
    expect((await signIn({ key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey })).status).toBe(401);
    expect((await signIn({}, "https://evil.test")).status).toBe(401);
    expect((await signIn({ counter: 1 })).body.error.message).toContain("counter");

    const audit = (await call(`/api/v1/teams/${teamId}/audit?limit=500`, as.viewer)).body.data as ChainedEntry[];
    expect(audit.find((e) => e.action === "member.join" && e.target === pid)).toMatchObject({ actor: `passkey:${pid}`, detail: { kind: "passkey", role: "dev" } });
    expect(audit.filter((e) => e.action === "key.create" && e.actor === `passkey:${pid}`).length).toBe(2);

    // A dev cannot revoke; an admin can, and every key issued to the member stops working.
    expect((await call(`/api/v1/teams/${teamId}/principals/${pid}`, as.dev, "DELETE")).status).toBe(403);
    const revoked = await call(`/api/v1/teams/${teamId}/principals/${pid}`, as.admin, "DELETE");
    expect(revoked.body.data).toEqual({ id: pid, revoked: true, keys_disabled: 2 });
    expect((await call(`/api/v1/teams/${teamId}`, memberAuth)).status).toBe(401);
    expect((await signIn()).status).toBe(401);
  });

  test("a member joins and signs in with a wallet signature", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const invite = (await call(`/api/v1/teams/${teamId}/invites`, as.owner, "POST", { role: "viewer", method: "wallet" })).body.data.invite;
    const ch = await call("/api/v1/teams/join/challenge", undefined, "POST", { invite, method: "wallet", address: wallet.address });
    expect(ch.body.data.message).toContain(`join team ${teamId} as viewer`);
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect((await call("/api/v1/teams/join", undefined, "POST", { invite, challenge_id: ch.body.data.challenge_id, wallet: { address: wallet.address, signature: await stranger.signMessage({ message: ch.body.data.message }) } })).status).toBe(401);
    const joined = await call("/api/v1/teams/join", undefined, "POST", { invite, challenge_id: ch.body.data.challenge_id, wallet: { address: wallet.address, signature: await wallet.signMessage({ message: ch.body.data.message }) } });
    expect(joined.status).toBe(201);
    expect(joined.body.data.principal).toMatchObject({ kind: "wallet", role: "viewer" });
    const c = await call(`/api/v1/teams/${teamId}/sign-in/challenge`, undefined, "POST", { method: "wallet", address: wallet.address });
    const s = await call(`/api/v1/teams/${teamId}/sign-in`, undefined, "POST", { challenge_id: c.body.data.challenge_id, wallet: { address: wallet.address, signature: await wallet.signMessage({ message: c.body.data.message }) } });
    expect(s.status).toBe(201);
    const viewerAuth = { authorization: `Bearer ${s.body.key}` };
    expect((await call(`/api/v1/teams/${teamId}/invites`, viewerAuth, "POST", { role: "viewer" })).status).toBe(403);
    expect((await call(`/api/v1/teams/${teamId}/audit`, viewerAuth)).status).toBe(200);
  });

  test("a Safe (EIP-1271 contract wallet) owns the team and signs in as owner", async () => {
    // A mock Safe with one owner and threshold 1: it has code, and isValidSignature accepts a signature by its owner over the hash.
    const safe = "0x5afe00000000000000000000000000000000c0de" as Hex;
    const signer = privateKeyToAccount(generatePrivateKey());
    const client = h.ctx.chain.client as unknown as { getCode: unknown; readContract: unknown };
    const saved = { getCode: client.getCode, readContract: client.readContract };
    const calls: string[] = [];
    client.getCode = async ({ address }: { address: Hex }) => (address.toLowerCase() === safe ? "0x6080604052" : "0x");
    client.readContract = async ({ address, functionName, args }: { address: Hex; functionName: string; args: [Hex, Hex] }) => {
      calls.push(`${address.toLowerCase()}.${functionName}`);
      if (address.toLowerCase() !== safe || functionName !== "isValidSignature") throw new Error("unexpected call");
      const who = await recoverAddress({ hash: args[0], signature: args[1] }).catch(() => null);
      return who === signer.address ? "0x1626ba7e" : "0xffffffff";
    };
    try {
      const ch = await call(`/api/v1/teams/${teamId}/owner/challenge`, as.owner, "POST", { address: safe });
      const intruder = privateKeyToAccount(generatePrivateKey());
      const bad = await call(`/api/v1/teams/${teamId}/owner`, as.owner, "POST", { address: safe, nonce: ch.body.data.nonce, signature: await intruder.signMessage({ message: ch.body.data.message }) });
      expect([bad.status, bad.body.error.type]).toEqual([401, "invalid_signature"]);
      const bound = await call(`/api/v1/teams/${teamId}/owner`, as.owner, "POST", { address: safe, nonce: ch.body.data.nonce, signature: await signer.signMessage({ message: ch.body.data.message }) });
      expect(bound.status).toBe(200);
      expect(bound.body.data.owner).toMatchObject({ address: safe, kind: "contract" });
      expect(calls).toContain(`${safe}.isValidSignature`);
      // An admin cannot rebind the owner.
      expect((await call(`/api/v1/teams/${teamId}/owner/challenge`, as.admin, "POST", { address: safe })).status).toBe(403);

      const c = await call(`/api/v1/teams/${teamId}/sign-in/challenge`, undefined, "POST", { method: "wallet", address: safe });
      const s = await call(`/api/v1/teams/${teamId}/sign-in`, undefined, "POST", { challenge_id: c.body.data.challenge_id, wallet: { address: safe, signature: await signer.signMessage({ message: c.body.data.message }) } });
      expect(s.status).toBe(201);
      expect(s.body.data.principal.role).toBe("owner");
      const ownerAuth = { authorization: `Bearer ${s.body.key}` };
      expect((await call(`/api/v1/teams/${teamId}`, ownerAuth)).body.data.your_role).toBe("owner");
      expect((await call(`/api/v1/teams/${teamId}/invites`, ownerAuth, "POST", { role: "admin" })).status).toBe(201);
      const entries = (await call(`/api/v1/teams/${teamId}/audit?limit=500`, as.viewer)).body.data as ChainedEntry[];
      expect(entries.find((e) => e.action === "owner.bind")).toMatchObject({ target: safe, detail: { kind: "contract" } });
      expect(entries.at(-1)).toMatchObject({ action: "invite.create", actor: `wallet:${safe}` });
    } finally {
      Object.assign(client, saved);
    }
  });

  test("a team made by a wallet-signed-in account is owned by that wallet (EOA)", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const ch = await call("/api/v1/auth/wallet/challenge", undefined, "POST", { address: wallet.address });
    const signedIn = await call("/api/v1/auth/wallet", undefined, "POST", { address: wallet.address, nonce: ch.body.data.nonce, signature: await wallet.signMessage({ message: ch.body.data.message }) });
    const t = await call("/api/v1/teams", { authorization: `Bearer ${signedIn.body.key}` }, "POST", { name: "wallet-org" });
    expect(t.body.data.owner).toMatchObject({ address: wallet.address.toLowerCase(), kind: "eoa" });
  });

  test("the audit log: preset and route changes without prompt text, pagination, exports that verify offline, append-only storage", async () => {
    const put = await call("/api/v1/presets/support", root.auth, "PUT", { models: [MODELS.llama.slug], system_prompt: "TOP SECRET SYSTEM PROMPT", provider: { lane: "public" } });
    expect(put.status).toBe(201);
    expect((await call("/api/v1/routes", root.auth, "POST", { slug: "cheap", config: { models: [MODELS.llama.slug] } })).status).toBe(201);

    const pages: ChainedEntry[] = [];
    let after = 0;
    for (;;) {
      const p = await call(`/api/v1/teams/${teamId}/audit?limit=4&after=${after}`, as.viewer);
      pages.push(...p.body.data);
      if (p.body.next_after === null) {
        expect(p.body.head.hash).toBe(pages.at(-1)!.hash);
        break;
      }
      after = p.body.next_after;
    }
    expect(pages.map((e) => e.seq)).toEqual(pages.map((_, i) => i + 1));
    expect(verifyChain(pages)).toMatchObject({ ok: true });
    const actions = new Set(pages.map((e) => e.action));
    for (const a of ["team.create", "key.create", "member.role", "invite.create", "member.join", "member.revoke", "key.update", "owner.bind", "preset.save", "route.create"]) expect(actions).toContain(a);
    expect(pages.find((e) => e.action === "preset.save")).toMatchObject({ target: "@preset/support", detail: { version: 1, lane: "public" } });

    const jsonl = await (await h.request(`/api/v1/teams/${teamId}/audit/export?format=jsonl`, { headers: as.viewer })).text();
    const csvRes = await h.request(`/api/v1/teams/${teamId}/audit/export?format=csv`, { headers: as.viewer });
    expect(csvRes.headers.get("content-disposition")).toContain(`anyroute-audit-${teamId}.csv`);
    const csv = await csvRes.text();
    for (const text of [jsonl, csv]) {
      expect(text).not.toContain("TOP SECRET");
      expect(verifyExport(text, { head: pages.at(-1)!.hash })).toMatchObject({ ok: true, entries: pages.length, team: teamId });
    }
    expect(JSON.parse(jsonl.split("\n")[0])).toMatchObject({ type: "header", format: "anyroute.audit.v1", genesis: GENESIS, entries: pages.length });
    const roots = (await call(`/api/v1/teams/${teamId}/audit/roots`, as.viewer)).body.data;
    expect(roots).toEqual(hourlyRoots(pages));
    // Tampering with one exported entry is caught offline.
    const tampered = jsonl.replace('"action":"owner.bind"', '"action":"owner.keep"');
    expect(verifyExport(tampered)).toMatchObject({ ok: false, seq: pages.find((e) => e.action === "owner.bind")!.seq });
    expect((await h.request(`/api/v1/teams/${teamId}/audit/export?format=xml`, { headers: as.viewer })).status).toBe(400);

    // The table refuses edits and deletions.
    const refused = (q: PromiseLike<unknown>) => Promise.resolve(q).then(() => "accepted", (e) => String(e?.cause?.message ?? e?.message));
    expect(await refused(h.ctx.db.update(teamAudit).set({ action: "rewritten" }).where(eq(teamAudit.teamId, teamId)))).toContain("append-only");
    expect(await refused(h.ctx.db.delete(teamAudit).where(eq(teamAudit.teamId, teamId)))).toContain("append-only");
  });
});
