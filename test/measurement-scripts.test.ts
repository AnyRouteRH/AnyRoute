import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { main as check, checkReproducible } from "../scripts/check-reproducible.ts";
import { checkPins, parsePins, readAppCompose } from "../scripts/lib/compose-pins.ts";
import { main as publish, submitToRekor } from "../scripts/publish-measurement.ts";
import { asBytes32, parseBundle, bundleBytes, digestHex, hashedrekordEntry, sameKey, verifySignature, parsePublicKey } from "../src/services/measurement-bundle.ts";
import { COMPOSE_TEXT, newSigner } from "./bundle-fixtures.ts";
import { MockRekor } from "./rekor-mock.ts";

const REPO = new URL("..", import.meta.url).pathname;
const COMPOSE_FILE = join(REPO, "sidecar/examples/phala/docker-compose.yml");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const ROUTER = "https://router.example.test";
const pins = parsePins(COMPOSE_TEXT);
const SIDECAR_IMAGE = pins.images.find((i) => i.service === "sidecar")!.digest;
const MODEL_DIGEST = pins.sidecar!.modelDigests[0]!;
const MRTD = "aa".repeat(48);
const COMPOSE_HASH = "sha256:" + "ab".repeat(32);

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "measurement-scripts-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ---- the example compose file -----------------------------------------------------------------------------

describe("the Phala example compose file", () => {
  test("is fully pinned, and each pin agrees with the others", () => {
    const checks = checkPins(pins);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(pins.images.map((i) => i.service).sort()).toEqual(["llama", "model-fetch", "sidecar"]);
    expect(pins.source).toMatchObject({ repository: "https://github.com/AnyRouteRH/AnyRoute", commit: "dcfc2deeacd8f3d89ea61d7e7045259e173e8050", path: "sidecar", tarballSha256: "sha256:5b297e38e0cbea6e7784e496458ca5b4b930cf2421094b282feeb3947f979027" });
    expect(pins.weights).toMatchObject({ file: "qwen2.5-0.5b-instruct-q4_k_m.gguf", sha256: "sha256:74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db" });
    // the model digest the sidecar accepts is derived from the pinned weights hash alone
    expect(pins.derivedModelDigest).toBe("sha256:1144b5db331424ae40213378a83575a5cf67090b0ce1ad49cf66ec75f17e2095");
    expect(pins.sidecar!.modelDigests).toEqual([pins.derivedModelDigest!]);
    expect(pins.sidecar!.imageDigest).toBe(SIDECAR_IMAGE);
  });
  test("the copy of sidecar.yaml inside the compose file is the file itself", () => {
    const yaml = readFileSync(join(REPO, "sidecar/examples/phala/sidecar.yaml"), "utf8");
    const embedded = (Bun.YAML.parse(COMPOSE_TEXT) as any).services.sidecar.environment.SIDECAR_CONFIG_YAML;
    expect(embedded).toBe(yaml);
  });
  test("a change to any pin is reported", () => {
    const edit = (from: string, to: string) => checkPins(parsePins(COMPOSE_TEXT.replace(from, to))).filter((c) => !c.ok).map((c) => c.id);
    expect(edit("oven/bun:1.3.14@sha256:e10577f0", "oven/bun:1.3.14@sha256:e10577f1")).toContain("declared_image_is_pinned");
    expect(edit("image: oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4", "image: oven/bun:1.3.14")).toContain("images_pinned");
    expect(edit("sum=74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db", "sum=74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9dc")).toContain("model_digest_derives_from_weights");
    expect(edit("model_digests: [\"sha256:1144b5db", "model_digests: [\"sha256:1144b5dc")).toContain("model_digest_derives_from_weights");
    expect(edit("rev=dcfc2deeacd8f3d89ea61d7e7045259e173e8050", "rev=nothex")).toContain("source_pinned");
  });
  test("app-compose.json is read as a file or from a platform document, and hashed as given", () => {
    const app = { manifest_version: 2, name: "x", runner: "docker-compose", docker_compose_file: COMPOSE_TEXT, kms_enabled: true };
    const text = JSON.stringify(app);
    expect(readAppCompose(text)).toMatchObject({ docker_compose_file: COMPOSE_TEXT, rawSha256: sha(text) });
    const wrapped = readAppCompose(JSON.stringify({ tcb_info: { app_compose: text } }));
    expect(wrapped).toMatchObject({ rawSha256: sha(text), docker_compose_file: COMPOSE_TEXT });
    expect(readAppCompose(JSON.stringify({ app_compose: app })).docker_compose_file).toBe(COMPOSE_TEXT);
    // pretty-printing changes the hash of the text but not of the key-sorted form
    const pretty = readAppCompose(JSON.stringify({ name: "x", docker_compose_file: COMPOSE_TEXT, runner: "docker-compose", manifest_version: 2, kms_enabled: true }, null, 2));
    expect(pretty.rawSha256).not.toBe(sha(text));
    expect(pretty.sortedSha256).toBe(readAppCompose(text).sortedSha256);
    expect(() => readAppCompose("nope")).toThrow("not JSON");
    expect(() => readAppCompose("{}")).toThrow("no app-compose");
  });
});

// ---- check-reproducible ------------------------------------------------------------------------------------

describe("check-reproducible", () => {
  // A tiny repository, its "GitHub tarball", and a compose file that pins them.
  let rev: string;
  let repo: string;
  let tarball: Buffer;
  let compose: string;
  beforeAll(() => {
    repo = join(dir, "repo");
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, TZ: "UTC", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    spawnSync("mkdir", ["-p", join(repo, "sidecar")]);
    git("init", "-q");
    writeFileSync(join(repo, "sidecar", "main.ts"), "console.log('sidecar');\n");
    writeFileSync(join(repo, "README.md"), "hello\n");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    rev = git("rev-parse", "HEAD");
    const tar = spawnSync("git", ["archive", "--format=tar", `--prefix=AnyRoute-${rev}/`, rev], { cwd: repo, maxBuffer: 1 << 28 }).stdout;
    tarball = Buffer.from(gzipSync(tar));
    compose = COMPOSE_TEXT.replace("rev=dcfc2deeacd8f3d89ea61d7e7045259e173e8050", `rev=${rev}`).replace("sum=5b297e38e0cbea6e7784e496458ca5b4b930cf2421094b282feeb3947f979027", `sum=${sha(tarball)}`);
  });
  const serve = (bytes: () => Uint8Array | Response, calls: string[] = []) =>
    (async (url: string | URL | Request) => {
      calls.push(String(url));
      const b = bytes();
      return b instanceof Response ? b : new Response(b);
    }) as unknown as typeof fetch;
  /** Ids of the required checks that passed (ok) or failed; informational lines are not counted as failures. */
  const ids = (r: Awaited<ReturnType<typeof checkReproducible>>, ok: boolean) => r.checks.filter((c) => c.ok === ok && (ok || c.kind === "required")).map((c) => c.id);

  test("passes when the download is stable and equals the pin, and the pinned tar is what git archive makes", async () => {
    const calls: string[] = [];
    const r = await checkReproducible({ composeText: compose, repoDir: repo }, { fetch: serve(() => tarball, calls) });
    expect(r.ok).toBe(true);
    const url = `https://codeload.github.com/AnyRouteRH/AnyRoute/tar.gz/${rev}`;
    expect(calls).toEqual([url, url]);
    expect(ids(r, true)).toEqual(expect.arrayContaining(["download_matches_pin", "download_is_stable", "git_archive_matches_tar"]));
    // the gzip bytes are reported, not required: a compressor other than GitHub's gives other bytes
    expect(r.checks.find((c) => c.id === "git_archive_gzip_bytes")).toMatchObject({ kind: "info" });
  });
  test("fails when the download is not the pinned tarball, is not stable, or cannot be fetched", async () => {
    const wrong = await checkReproducible({ composeText: compose }, { fetch: serve(() => gzipSync("something else")) });
    expect(wrong.ok).toBe(false);
    expect(ids(wrong, false)).toContain("download_matches_pin");
    let n = 0;
    const flip = await checkReproducible({ composeText: compose }, { fetch: serve(() => (n++ === 0 ? tarball : Buffer.concat([tarball, Buffer.from("x")]))) });
    expect(ids(flip, false)).toEqual(["download_is_stable"]);
    const down = await checkReproducible({ composeText: compose }, { fetch: serve(() => new Response("no", { status: 503 })) });
    expect(down.checks.find((c) => c.id === "download_matches_pin")).toMatchObject({ ok: false, detail: expect.stringContaining("HTTP 503") });
  });
  test("fails when the pinned tarball's content is not what git archive makes of the commit", async () => {
    const other = Buffer.from(gzipSync("not a tar of this repository"));
    const drifted = COMPOSE_TEXT.replace("rev=dcfc2deeacd8f3d89ea61d7e7045259e173e8050", `rev=${rev}`).replace("sum=5b297e38e0cbea6e7784e496458ca5b4b930cf2421094b282feeb3947f979027", `sum=${sha(other)}`);
    const r = await checkReproducible({ composeText: drifted, repoDir: repo }, { fetch: serve(() => other) });
    expect(ids(r, false)).toEqual(["git_archive_matches_tar"]);
    const missing = await checkReproducible({ composeText: compose, repoDir: dir }, { fetch: serve(() => tarball) });
    expect(missing.checks.find((c) => c.id === "git_archive")).toMatchObject({ kind: "info", ok: false, detail: expect.stringContaining("does not have commit") });
  });
  test("offline, and with a local file in place of the first download, no request is made", async () => {
    const calls: string[] = [];
    const off = await checkReproducible({ composeText: compose, offline: true }, { fetch: serve(() => tarball, calls) });
    expect(off.ok).toBe(true);
    expect(calls).toHaveLength(0);
    const file = join(dir, "src.tar.gz");
    writeFileSync(file, tarball);
    const local = await checkReproducible({ composeText: compose, offline: true, tarballFile: file, repoDir: repo }, { fetch: serve(() => tarball, calls) });
    expect(local.ok).toBe(true);
    expect(ids(local, true)).toContain("git_archive_matches_tar");
    expect(calls).toHaveLength(0);
  });
  test("compares the compose hash with the CVM's app-compose.json", async () => {
    const app = JSON.stringify({ manifest_version: 2, name: "demo", runner: "docker-compose", docker_compose_file: compose, kms_enabled: true });
    const good = await checkReproducible({ composeText: compose, offline: true, appComposeText: app, composeHash: "sha256:" + sha(app) }, { fetch });
    expect(good.ok).toBe(true);
    expect(good.checks.find((c) => c.id === "app_compose_hash_matches")!.detail).toContain("as given");
    expect(good.checks.find((c) => c.id === "app_compose_embeds_this_file")!.ok).toBe(true);
    // the hash of a key-sorted rendering is accepted and named as such
    const reordered = JSON.stringify({ name: "demo", runner: "docker-compose", docker_compose_file: compose, manifest_version: 2, kms_enabled: true }, null, 1);
    const sorted = readAppCompose(app).sortedSha256;
    const viaSorted = await checkReproducible({ composeText: compose, offline: true, appComposeText: reordered, composeHash: `0x${sorted}` }, { fetch });
    expect(viaSorted.ok).toBe(true);
    expect(viaSorted.checks.find((c) => c.id === "app_compose_hash_matches")!.detail).toContain("key-sorted");
    const bad = await checkReproducible({ composeText: compose, offline: true, appComposeText: app, composeHash: COMPOSE_HASH }, { fetch });
    expect(ids(bad, false)).toEqual(["app_compose_hash_matches"]);
    const differs = await checkReproducible({ composeText: compose, offline: true, appComposeText: JSON.stringify({ docker_compose_file: compose + "\n# edited" }) }, { fetch });
    expect(ids(differs, false)).toEqual(["app_compose_embeds_this_file"]);
    const junk = await checkReproducible({ composeText: compose, offline: true, appComposeText: "nope" }, { fetch });
    expect(junk.ok).toBe(false);
  });
  test("the command line exits 0 when everything ran clean, 1 when a check failed, 2 on bad usage", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps = { fetch: serve(() => tarball), out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
    const file = join(dir, "compose.yml");
    writeFileSync(file, compose);
    expect(await check(["--compose", file, "--repo", repo, "--json"], deps)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ ok: true, composeSha256: sha(compose) });
    out.length = 0;
    expect(await check(["--compose", file, "--offline"], deps)).toBe(0);
    expect(out.join("\n")).toContain("reproducible: every check that ran passed");
    expect(await check(["--compose", file], { ...deps, fetch: serve(() => gzipSync("x")) })).toBe(1);
    expect(await check(["--compose", join(dir, "missing.yml")], deps)).toBe(2);
    expect(await check(["--bogus"], deps)).toBe(2);
    expect(err.length).toBeGreaterThan(0);
  });
});

// ---- publish-measurement -----------------------------------------------------------------------------------

describe("publish-measurement", () => {
  const signer = newSigner();
  let rekor: MockRekor;
  let routerCalls: { method: string; path: string; body?: any; auth?: string }[];
  let router: { status: string; measurement: Record<string, unknown> | null; bundles: any[] | null; submit: { status: number; body: unknown } };
  let out: string[];
  let err: string[];
  let n = 0;

  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (u.startsWith(rekor.baseUrl)) return rekor.fetch(url, init);
    if (!u.startsWith(ROUTER)) return new Response("unknown host", { status: 502 });
    const path = u.slice(ROUTER.length);
    routerCalls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string> | undefined)?.authorization });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/v1/attestation/phala-test") return router.measurement ? json({ data: { provider: "phala-test", status: router.status, measurement: router.measurement } }) : json({ data: { status: router.status, measurement: null } });
    if (path === "/api/v1/measurements/bundles/phala-test") return router.bundles ? json({ data: router.bundles }) : json({ error: { message: "not configured" } }, 404);
    if (path === "/api/v1/measurements/key") return json({ data: { public_key_pem: signer.publicPem } });
    if (path === "/trpc/measurements.submitBundle") return json(router.submit.body, router.submit.status);
    return json({}, 404);
  }) as unknown as typeof fetch;

  const run = (argv: string[], env: Record<string, string | undefined> = { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: rekor.baseUrl }) =>
    publish(argv, { env, fetch: fetchImpl, out: (s) => out.push(s), err: (s) => err.push(s), now: () => new Date("2026-09-29T12:00:00.000Z"), wait: async () => {} });
  const outFile = () => join(dir, `record-${++n}.json`);
  const args = (extra: string[] = []) => ["--provider", "phala-test", "--router-url", ROUTER, "--compose", COMPOSE_FILE, ...extra];
  const stdout = () => out.join("\n");
  const stderr = () => err.join("\n");

  beforeEach(() => {
    rekor = new MockRekor();
    routerCalls = [];
    out = [];
    err = [];
    router = {
      status: "attested",
      measurement: { compose_hash: "0x" + "ab".repeat(32), image_digest: "0x" + SIDECAR_IMAGE.slice(7), model_digest: "0x" + MODEL_DIGEST.slice(7), registers: { mrtd: MRTD, rtmr3: "bb".repeat(48) } },
      bundles: [],
      submit: { status: 200, body: { result: { data: { status: "verified", bundle_digest: "0xabc", error: null, transparency_log: { inclusion_verified: true, checkpoint_signature_verified: true, signed_entry_timestamp_verified: true } } } } },
    };
  });

  test("--dry-run builds and prints the entry from the compose file and the router's record, and sends nothing", async () => {
    expect(await run(args(["--dry-run"]))).toBe(0);
    const printed = JSON.parse(stdout());
    expect(printed.dry_run).toBe(true);
    const bundle = parseBundle(printed.bundle);
    expect(bundle).toMatchObject({
      provider: "phala-test",
      created_at: "2026-09-29T12:00:00.000Z",
      compose_hash: COMPOSE_HASH,
      source: { repository: "https://github.com/AnyRouteRH/AnyRoute", commit: "dcfc2deeacd8f3d89ea61d7e7045259e173e8050", path: "sidecar", tarball_sha256: "sha256:5b297e38e0cbea6e7784e496458ca5b4b930cf2421094b282feeb3947f979027" },
      model: { digest: MODEL_DIGEST, weights: [{ file: "qwen2.5-0.5b-instruct-q4_k_m.gguf", sha256: "sha256:74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db" }] },
      tdx: { mrtd: [MRTD], rtmr3: [] }, // RTMR3 is instance-specific: not pinned unless asked for
    });
    expect(bundle.images.map((i) => i.service).sort()).toEqual(["llama", "model-fetch", "sidecar"]);
    expect(sameKey(parsePublicKey(bundle.signer.public_key_pem), signer.publicKey)).toBe(true);
    // the request body is the bundle's hashedrekord entry, and the signature verifies over the bundle bytes
    const bytes = bundleBytes(bundle);
    expect(printed.bundle_digest).toBe(`sha256:${digestHex(bytes)}`);
    expect(verifySignature(bytes, printed.signature, signer.publicKey)).toBe(true);
    expect(printed.rekor_request).toMatchObject({ method: "POST", url: `${rekor.baseUrl}/api/v1/log/entries` });
    expect(printed.rekor_request.body.spec.data.hash).toEqual({ algorithm: "sha256", value: digestHex(bytes) });
    expect(printed.rekor_request.body.spec.signature.content).toBe(printed.signature);
    // nothing was submitted anywhere: the log saw no request, the router only reads
    expect(rekor.calls).toHaveLength(0);
    expect(routerCalls.every((c) => c.method === "GET")).toBe(true);
    expect(stderr()).toContain("nothing was sent");
    expect(readdirSync(dir).filter((f) => f.startsWith("measurement-"))).toEqual([]);
  });
  test("the private key never appears in the output, in any format, and a wrong key is refused without quoting it", async () => {
    const body = signer.privatePem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
    const der = (signer.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
    await run(args(["--dry-run"]));
    await run(args(["--dry-run"]), { MEASUREMENT_SIGNING_KEY: der });
    for (const s of [stdout(), stderr()]) {
      expect(s).not.toContain(body.slice(0, 40));
      expect(s).not.toContain(der.slice(0, 40));
      expect(s).not.toContain("PRIVATE KEY");
    }
    err.length = 0;
    expect(await run(args(["--dry-run"]), { MEASUREMENT_SIGNING_KEY: "SECRET-XYZ-not-a-key" })).toBe(1);
    expect(stderr()).not.toContain("SECRET-XYZ");
    expect(await run(args(["--dry-run"]), {})).toBe(1);
    expect(stderr()).toContain("MEASUREMENT_SIGNING_KEY is not set");
  });
  test("publishing submits the entry once, verifies what the log returns, and writes the publication record", async () => {
    const file = outFile();
    expect(await run(args(["--out", file]), { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: rekor.baseUrl, REKOR_PUBLIC_KEY: rekor.publicKeyPem })).toBe(0);
    expect(rekor.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const bytes = bundleBytes(parseBundle(rec.bundle));
    expect(rec).toMatchObject({ type: "anyroute.measurement.publication", version: 1, bundle_digest: `sha256:${digestHex(bytes)}`, signature_algorithm: "ecdsa-p256-sha256", submitted_at: "2026-09-29T12:00:00.000Z" });
    expect(verifySignature(bytes, rec.signature, signer.publicKey)).toBe(true);
    expect(rec.rekor).toMatchObject({
      url: rekor.baseUrl,
      already_existed: false,
      entry_url: `${rekor.baseUrl}/api/v1/log/entries/${rec.rekor.uuid}`,
      log_id: rekor.logId,
      checkpoint_signature_verified: true,
      signed_entry_timestamp_verified: true,
    });
    expect(rec.rekor.uuid).toMatch(/^[0-9a-f]{80}$/);
    expect(Number.isSafeInteger(rec.rekor.log_index)).toBe(true);
    expect(Number.isSafeInteger(rec.rekor.integrated_time)).toBe(true);
    expect(rec.rekor.inclusion_proof).toMatchObject({ tree_size: rekor.size, root_hash: expect.stringMatching(/^[0-9a-f]{64}$/), hashes: expect.any(Array), checkpoint: expect.stringContaining(`${rekor.size}\n`) });
    expect(typeof rec.rekor.signed_entry_timestamp).toBe("string");
    expect(typeof rec.rekor.body).toBe("string");
    expect(stdout()).toContain(rec.rekor.entry_url);
    expect(stdout()).toContain("checkpoint signature yes");
    // without the log's key the same run says the checkpoint was not checked
    out.length = 0;
    expect(await run(args(["--out", outFile(), "--force"]))).toBe(0);
    expect(stdout()).toContain("checkpoint signature no (set REKOR_PUBLIC_KEY to check it)");
  });
  test("a record verifies online and offline against the router's published key, and not against another key", async () => {
    const file = outFile();
    await run(args(["--out", file]));
    out.length = 0;
    expect(await run(["--verify", file, "--router-url", ROUTER])).toBe(0);
    expect(stdout()).toContain("the bundle names the key the router publishes");
    expect(stdout()).not.toContain("FAIL");
    out.length = 0;
    const offline = join(dir, "other.pem");
    expect(await run(["--verify", file, "--offline"])).toBe(0); // the key inside the bundle, labelled as unchecked
    expect(stdout()).toContain("not independently checked");
    out.length = 0;
    writeFileSync(offline, newSigner().publicPem);
    expect(await run(["--verify", file, "--public-key", offline, "--offline"])).toBe(1);
    expect(stdout()).toContain("FAIL");
    // a record whose log entry is not what it claims fails the online check
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.rekor.uuid = rekor.uuids()[0];
    const forged = outFile();
    writeFileSync(forged, JSON.stringify(rec));
    out.length = 0;
    expect(await run(["--verify", forged, "--router-url", ROUTER])).toBe(1);
    expect(stdout()).toMatch(/FAIL log entry/);
  });
  test("--handover gives the router the bundle, its signature and the entry uuid, with the operator token", async () => {
    const file = outFile();
    expect(await run(args(["--out", file, "--handover"]), { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: rekor.baseUrl, ADMIN_TOKEN: "operator-secret" })).toBe(0);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const call = routerCalls.find((c) => c.path === "/trpc/measurements.submitBundle")!;
    expect(call).toMatchObject({ method: "POST", auth: "Bearer operator-secret", body: { bundle: rec.bundle, signature: rec.signature, rekor_uuid: rec.rekor.uuid } });
    expect(stdout()).toContain("is verified");
    expect(stdout() + stderr()).not.toContain("operator-secret");
    // --resume hands an existing record over without touching the log
    rekor.calls.length = 0;
    out.length = 0;
    expect(await run(["--resume", file, "--router-url", ROUTER], { ADMIN_TOKEN: "operator-secret", REKOR_URL: rekor.baseUrl })).toBe(0);
    expect(rekor.calls).toHaveLength(0);
    expect(routerCalls.filter((c) => c.path === "/trpc/measurements.submitBundle")).toHaveLength(2);
    // a refusal is reported, with the router's reason
    router.submit = { status: 400, body: { error: { message: "The bundle names a different signing key than the one this router trusts." } } };
    err.length = 0;
    expect(await run(["--resume", file, "--router-url", ROUTER], { ADMIN_TOKEN: "operator-secret" })).toBe(1);
    expect(stderr()).toContain("different signing key");
    expect(await run(["--resume", file, "--router-url", ROUTER], {})).toBe(1);
    expect(stderr()).toContain("ADMIN_TOKEN");
    expect(await run(args(["--handover", "--dry-run"]), { MEASUREMENT_SIGNING_KEY: signer.privatePem })).toBe(1);
  });
  test("the compose hash can come from the app-compose.json, and it must embed the compose file byte for byte", async () => {
    router.measurement = null;
    const app = JSON.stringify({ manifest_version: 2, name: "x", runner: "docker-compose", docker_compose_file: COMPOSE_TEXT });
    const file = join(dir, "app-compose.json");
    writeFileSync(file, app);
    const noRouter = ["--provider", "phala-test", "--compose", COMPOSE_FILE, "--app-compose", file, "--mrtd", MRTD, "--dry-run"];
    expect(await run(noRouter)).toBe(0);
    expect(JSON.parse(stdout()).bundle.compose_hash).toBe(`sha256:${sha(app)}`);
    writeFileSync(file, JSON.stringify({ docker_compose_file: COMPOSE_TEXT + "#" }));
    err.length = 0;
    expect(await run(noRouter)).toBe(1);
    expect(stderr()).toContain("not the compose file given");
  });
  test("an attestation document supplies the compose hash and MRTD, and RTMR3 is pinned only on request", async () => {
    const { tdxQuote, REGS } = await import("./measurement-fixtures.ts");
    const doc = { evidence: { quote: tdxQuote("00".repeat(64)) }, bindings: { compose_hash: "sha256:" + "cd".repeat(32), image_digest: SIDECAR_IMAGE, model_digest: MODEL_DIGEST } };
    const file = join(dir, "attest.json");
    writeFileSync(file, JSON.stringify(doc));
    const base = ["--provider", "phala-test", "--compose", COMPOSE_FILE, "--attest", file, "--dry-run"];
    expect(await run(base)).toBe(0);
    expect(JSON.parse(stdout()).bundle).toMatchObject({ compose_hash: "sha256:" + "cd".repeat(32), tdx: { mrtd: [REGS.mrtd], rtmr3: [] } });
    out.length = 0;
    expect(await run([...base, "--pin-rtmr3", "--mrtd", "ee".repeat(48)])).toBe(0);
    expect(JSON.parse(stdout()).bundle.tdx).toEqual({ mrtd: [REGS.mrtd, "ee".repeat(48)].sort(), rtmr3: [REGS.rtmr3] });
  });
  test("refuses to describe a deployment that is not the public compose file, or that the router does not vouch for", async () => {
    const refused = async (argv: string[], reason: string, env?: Record<string, string | undefined>) => {
      err.length = 0;
      out.length = 0;
      expect(await run(argv, env), reason).toBe(1);
      expect(stderr(), reason).toContain(reason);
      expect(rekor.calls.filter((c) => c.method === "POST"), reason).toHaveLength(0);
      expect(stdout(), reason).not.toContain("published");
    };
    const dry = (extra: string[] = []) => args(["--dry-run", ...extra]);
    router.measurement = { ...router.measurement!, image_digest: "0x" + "99".repeat(32) };
    await refused(dry(), "is not an image in the compose file");
    router.measurement = { ...router.measurement, image_digest: "0x" + SIDECAR_IMAGE.slice(7), model_digest: "0x" + "98".repeat(32) };
    await refused(dry(), "is not the one this compose file allows");
    router.measurement = { ...router.measurement, model_digest: "0x" + MODEL_DIGEST.slice(7) };
    await refused(dry(["--compose-hash", "sha256:" + "dd".repeat(32)]), "disagree about the composeHash");
    router.status = "unverified";
    await refused(dry(), "does not currently call phala-test attested");
    router.status = "attested";
    router.measurement = { ...router.measurement, registers: null };
    await refused(dry(), "no MRTD for the allow-list");
    router.measurement = { ...router.measurement, registers: { mrtd: MRTD, rtmr3: null } };
    await refused(dry(["--pin-rtmr3"]), "--pin-rtmr3 needs a source for RTMR3");
    await refused(dry(["--mrtd", "abc"]), "96 hex characters");
    await refused(["--provider", "phala-test", "--compose", COMPOSE_FILE, "--dry-run"], "no source for the compose hash");
    const broken = join(dir, "unpinned.yml");
    writeFileSync(broken, COMPOSE_TEXT.replace(`@sha256:${SIDECAR_IMAGE.slice(7)}`, ""));
    await refused(["--provider", "phala-test", "--router-url", ROUTER, "--compose", broken, "--dry-run"], "pins do not agree");
    await refused(["--provider", "phala-test", "--router-url", ROUTER, "--compose", join(dir, "nope.yml"), "--dry-run"], "no such file");
  });
  test("never overwrites a file, and does not publish twice for one compose hash unless forced", async () => {
    const file = outFile();
    writeFileSync(file, "keep me");
    expect(await run(args(["--out", file]))).toBe(1);
    expect(stderr()).toContain("never overwritten");
    expect(readFileSync(file, "utf8")).toBe("keep me");
    expect(rekor.calls).toHaveLength(0);

    router.bundles = [{ status: "verified", compose_hash: asBytes32(COMPOSE_HASH), bundle_digest: "0x" + "12".repeat(32) }];
    err.length = 0;
    expect(await run(args(["--out", outFile()]))).toBe(1);
    expect(stderr()).toContain("already holds a verified bundle");
    expect(rekor.calls).toHaveLength(0);
    expect(await run(args(["--out", outFile(), "--force"]))).toBe(0);
    expect(rekor.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    // a bundle for another compose hash, or one that failed, does not stand in the way
    router.bundles = [{ status: "rejected", compose_hash: asBytes32(COMPOSE_HASH), bundle_digest: "0x1" }, { status: "verified", compose_hash: "0x" + "00".repeat(32), bundle_digest: "0x2" }];
    expect(await run(args(["--out", outFile()]))).toBe(0);
    // a router with bundles switched off (404) is not an obstacle either
    router.bundles = null;
    expect(await run(args(["--out", outFile()]))).toBe(0);
  });
  test("a log that answers with an entry that is not this bundle's is caught before anything is written or handed over", async () => {
    const file = outFile();
    const lying = (async (url: string | URL | Request, init: RequestInit = {}) => {
      const res = await fetchImpl(url, init);
      if (init.method !== "POST" || !String(url).endsWith("/api/v1/log/entries")) return res;
      // the log returns some other entry it holds
      const other = rekor.uuids()[0]!;
      return new Response(JSON.stringify(rekor.entryJson(other)), { status: 201 });
    }) as unknown as typeof fetch;
    const code = await publish(args(["--out", file, "--handover"]), { env: { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: rekor.baseUrl, ADMIN_TOKEN: "t" }, fetch: lying, out: (s) => out.push(s), err: (s) => err.push(s), now: () => new Date(), wait: async () => {} });
    expect(code).toBe(1);
    expect(stderr()).toContain("does not verify");
    expect(existsSync(file)).toBe(false);
    expect(routerCalls.some((c) => c.path.startsWith("/trpc"))).toBe(false);
  });
  test("Rekor's answers are handled: an error status, an entry that already exists (409), and an inclusion proof that arrives late", async () => {
    const s = { bytes: Buffer.from("x"), entry: hashedrekordEntry(Buffer.from("x"), "AAAA", signer.publicKey) };
    // 409: the entry is there, and the answer says where
    const first = await submitToRekor(rekor.fetch, rekor.baseUrl, s.entry);
    expect(first.existed).toBe(false);
    const again = await submitToRekor(rekor.fetch, rekor.baseUrl, s.entry);
    expect(again).toMatchObject({ existed: true, uuid: first.uuid });
    // a server error is reported without the request body
    rekor.outage = 500;
    await expect(submitToRekor(rekor.fetch, rekor.baseUrl, s.entry)).rejects.toThrow("Rekor answered HTTP 500");
    rekor.outage = null;
    await expect(submitToRekor(rekor.fetch, rekor.baseUrl, { kind: "hashedrekord" })).rejects.toThrow("HTTP 400");

    // an inclusion proof that is missing at first: the script waits and asks again
    const file = outFile();
    rekor.withholdProofs = true;
    let waits = 0;
    const late = (async (url: string | URL | Request, init: RequestInit = {}) => {
      if ((init.method ?? "GET") === "GET" && String(url).includes("/api/v1/log/entries/")) rekor.withholdProofs = false;
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const code = await publish(args(["--out", file]), { env: { MEASUREMENT_SIGNING_KEY: signer.privatePem, REKOR_URL: rekor.baseUrl }, fetch: late, out: (x) => out.push(x), err: (x) => err.push(x), now: () => new Date(), wait: async () => void waits++ });
    expect(code).toBe(0);
    expect(waits).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).rekor.inclusion_proof).not.toBeNull();
  });
  test("usage errors exit 2", async () => {
    expect(await run([])).toBe(2);
    expect(await run(["--nope"])).toBe(2);
    expect(stderr()).toContain("usage:");
  });
});
