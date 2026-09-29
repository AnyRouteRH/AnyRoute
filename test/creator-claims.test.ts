import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { keccak256, toBytes } from "viem";
import { ADMIN, startRouter, type Harness } from "./helpers.ts";
import { laneClaims, models, modelsLane } from "../src/db/schema.ts";

// Hugging Face is a function the router is handed; no test here reaches the network.

const HUB = "http://hub.test";
const MODEL = { id: "claim-model", slug: "lanetest/claim-model", prompt: "0.0000002", completion: "0.0000004", hf: "claimer/claim-model" };
const NOSOURCE = { id: "no-source", slug: "lanetest/no-source", prompt: "0.0000002", completion: "0.0000004", hf: "claimer/no-source" };
const LIMITED = { id: "limited", slug: "lanetest/limited", prompt: "0.0000002", completion: "0.0000004", hf: "claimer/limited" };
const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";

const hub = {
  owner: "claimer",
  isPrivate: false,
  down: false,
  files: {} as Record<string, string>,
  calls: [] as string[],
};

const fakeHub = (async (input: unknown) => {
  const url = new URL(String(input));
  hub.calls.push(String(input));
  if (url.origin !== HUB) throw new Error(`unexpected origin ${url.origin}`);
  if (hub.down) return new Response("unavailable", { status: 503 });
  const info = /^\/api\/models\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (info) return Response.json({ id: `${hub.owner}/${info[2]}`, author: hub.owner, sha: "d".repeat(40), private: hub.isPrivate, gated: false, disabled: false, tags: [], cardData: {} });
  const file = /^\/([^/]+\/[^/]+)\/raw\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (file) {
    const body = hub.files[`${file[1]}@${file[2]}:${file[3]}`];
    return body == null ? new Response("missing", { status: 404 }) : new Response(body);
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const publish = (repo: string, content: string, file = "anyroute-claim.txt", rev = "main") => {
  hub.files[`${repo}@${rev}:${file}`] = content;
};

let h: Harness;
const auth = { current: {} as Record<string, string> };
const admin = { "x-admin-token": ADMIN };
const issue = (json: unknown) => h.request("/api/v1/creators/claims", { method: "POST", json });
const verify = (id: string) => h.request(`/api/v1/creators/claims/${id}/verify`, { method: "POST" });
const chat = () => h.request("/api/v1/chat/completions", { method: "POST", headers: auth.current, json: { model: MODEL.slug, temperature: 0, messages: [{ role: "user", content: `hello ${Math.random()}` }] } });
const modelRow = async (id = MODEL.slug) => (await h.ctx.db.select().from(models).where(eq(models.id, id)))[0];
const declareSource = (m: { slug: string; hf: string }) =>
  h.request(`/api/v1/models/${m.slug}/lane`, { method: "PUT", headers: admin, json: { variant: "mainstream", weights: { source: `huggingface:${m.hf}` }, creator_handle: undefined } });

beforeAll(async () => {
  h = await startRouter({
    env: { HF_BASE_URL: HUB },
    providers: [{ id: "vendor", name: "Vendor", models: [MODEL, NOSOURCE, LIMITED] }],
  });
  h.ctx.hfFetch = fakeHub;
  auth.current = (await h.fundedKey(20n)).auth;
  expect((await declareSource(MODEL)).status).toBe(200);
  expect((await declareSource(LIMITED)).status).toBe(200);
});
afterAll(async () => h.close());

describe("issuing a challenge", () => {
  test("an unknown model, or one with no recorded weights source, cannot be claimed", async () => {
    expect((await issue({ model: "lanetest/nothing", address: ALICE })).status).toBe(404);
    const r = await issue({ model: NOSOURCE.slug, address: ALICE });
    expect(r.status).toBe(409);
    expect((await r.json()).error.type).toBe("not_claimable");
    // A source that is not a Hugging Face repository is no basis for a claim either.
    await h.request(`/api/v1/models/${NOSOURCE.slug}/lane`, { method: "PUT", headers: admin, json: { variant: "mainstream", weights: { source: "https://example.org/weights.tar" } } });
    expect((await issue({ model: NOSOURCE.slug, address: ALICE })).status).toBe(409);
    expect(await h.ctx.db.select().from(laneClaims)).toEqual([]);
  });

  test("the request is validated", async () => {
    expect((await issue({ model: MODEL.slug, address: "0x123" })).status).toBe(400);
    expect((await issue({ model: MODEL.slug, address: `0x${"0".repeat(40)}` })).status).toBe(400);
    expect((await issue({ model: MODEL.slug })).status).toBe(400);
    expect((await issue({ model: MODEL.slug, address: ALICE, extra: 1 })).status).toBe(400);
    const wrongHandle = await issue({ model: MODEL.slug, address: ALICE, hf_handle: "someone-else" });
    expect(wrongHandle.status).toBe(400);
    expect((await wrongHandle.json()).error.type).toBe("handle_mismatch");
    expect(await h.ctx.db.select().from(laneClaims)).toEqual([]);
  });

  test("a claim names the repository, the file to publish and its content, and expires", async () => {
    const r = await issue({ model: MODEL.slug, address: ALICE.toUpperCase().replace("0X", "0x"), hf_handle: "Claimer" });
    expect(r.status).toBe(201);
    const c = (await r.json()).data;
    expect(c).toMatchObject({ model: MODEL.slug, hugging_face_id: MODEL.hf, handle: "claimer", address: ALICE, status: "pending", file: "anyroute-claim.txt", royalty_bps: 500 });
    expect(c.id).toMatch(/^claim-/);
    expect(c.challenge).toMatch(/^anyroute-claim-[0-9a-f]{48}$/);
    expect(c.file_content).toBe(`${c.challenge}\n`);
    expect(Date.parse(c.expires_at)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // Nothing about the model changed yet.
    expect((await modelRow()).creator).toBeNull();
    const again = (await (await issue({ model: MODEL.slug, address: ALICE })).json()).data;
    expect(again.challenge).not.toBe(c.challenge);
    const read = await h.request(`/api/v1/creators/claims/${c.id}`);
    expect((await read.json()).data).toMatchObject({ id: c.id, status: "pending", expired: false });
    expect((await h.request("/api/v1/creators/claims/claim-nope")).status).toBe(404);
  });
});

describe("verifying it", () => {
  let claim: { id: string; challenge: string };
  const fresh = async (address = ALICE) => (await (await issue({ model: MODEL.slug, address })).json()).data as typeof claim;

  test("nothing is recorded until the file is published, and a wrong file does not count", async () => {
    claim = await fresh();
    const missing = await verify(claim.id);
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.type).toBe("claim_unverified");
    publish(MODEL.hf, "anyroute-claim-" + "0".repeat(48) + "\n");
    const wrong = await verify(claim.id);
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.type).toBe("claim_mismatch");
    // Contained in a line but not the line itself: not enough.
    publish(MODEL.hf, `see ${claim.challenge} for details\n`);
    expect((await verify(claim.id)).status).toBe(403);
    // Published on a branch other than main: not read.
    publish(MODEL.hf, claim.challenge, "anyroute-claim.txt", "dev");
    delete hub.files[`${MODEL.hf}@main:anyroute-claim.txt`];
    expect((await verify(claim.id)).status).toBe(400);
    expect((await modelRow()).creator).toBeNull();
  });

  test("a repository that is not public, is not found or was handed to someone else does not verify", async () => {
    publish(MODEL.hf, `${claim.challenge}\n`);
    hub.owner = "mallory"; // transferred
    const moved = await verify(claim.id);
    expect(moved.status).toBe(403);
    expect((await moved.json()).error.message).toMatch(/now owned by mallory/);
    hub.owner = "claimer";
    hub.isPrivate = true;
    expect((await verify(claim.id)).status).toBe(400);
    hub.isPrivate = false;
    hub.down = true;
    const down = await verify(claim.id);
    expect(down.status).toBe(502);
    expect((await down.json()).error.type).toBe("hf_unavailable");
    hub.down = false;
    expect((await modelRow()).creator).toBeNull();
  });

  test("a challenge published by the owner records the address as the royalty recipient at the default 5%", async () => {
    publish(MODEL.hf, `# Claim for the royalty of ${MODEL.slug}\n${claim.challenge}\nthanks\n`);
    const before = (await (await chat()).json()).usage.cost_details;
    expect(Number(before.royalty)).toBe(0); // nobody has claimed it: no royalty is charged
    const r = await verify(claim.id);
    expect(r.status).toBe(200);
    const done = (await r.json()).data;
    expect(done).toMatchObject({ id: claim.id, status: "verified", address: ALICE, royalty_bps: 500, onchain_tx: null });
    expect(done.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const m = await modelRow();
    expect(m).toMatchObject({ creator: ALICE, royaltyBps: 500 });
    const listed = ((await (await h.request("/api/v1/models")).json()) as { data: any[] }).data.find((x) => x.id === MODEL.slug);
    expect(listed).toMatchObject({ creator: ALICE, royalty_bps: 500, creator_handle: "claimer" });
    expect((await h.ctx.db.select().from(modelsLane).where(eq(modelsLane.modelId, MODEL.slug)))[0].creatorHandle).toBe("claimer");

    // The royalty is part of the price of every later call: 5% of the notional, in the existing accounting.
    const after = (await (await chat()).json()).usage.cost_details;
    expect(Number(after.royalty)).toBeGreaterThan(0);
    expect(Number(after.royalty) / Number(after.upstream_inference_cost)).toBeCloseTo(0.05, 3);
    const { generations } = await import("../src/db/schema.ts");
    const rows = await h.ctx.db.select({ royalty: generations.royalty, upstream: generations.upstreamCost }).from(generations).where(eq(generations.modelId, MODEL.slug));
    expect(rows.filter((g) => g.royalty > 0n).length).toBe(1);

    // Verifying again is harmless and says so.
    const again = await verify(claim.id);
    expect(again.status).toBe(200);
    expect((await again.json()).data).toMatchObject({ status: "verified", already_verified: true });
  });

  test("the challenge belongs to the address it was issued for: another claim cannot ride on it", async () => {
    const mine = await fresh(ALICE);
    const theirs = await fresh(BOB);
    expect(theirs.challenge).not.toBe(mine.challenge);
    publish(MODEL.hf, `${mine.challenge}\n`);
    expect((await verify(theirs.id)).status).toBe(403);
    expect((await modelRow()).creator).toBe(ALICE);
    publish(MODEL.hf, `${mine.challenge}\n${theirs.challenge}\n`);
    expect((await verify(theirs.id)).status).toBe(200); // whoever controls the repository decides who is paid
    expect((await modelRow()).creator).toBe(BOB);
  });

  test("a claim expires, and a changed weights source invalidates it", async () => {
    const old = await fresh();
    publish(MODEL.hf, `${old.challenge}\n`);
    await h.ctx.db.update(laneClaims).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(laneClaims.id, old.id));
    const gone = await verify(old.id);
    expect(gone.status).toBe(410);
    expect((await gone.json()).error.type).toBe("claim_expired");
    expect((await (await h.request(`/api/v1/creators/claims/${old.id}`)).json()).data.expired).toBe(true);

    const stale = await fresh();
    publish(MODEL.hf, `${stale.challenge}\n`);
    await h.request(`/api/v1/models/${MODEL.slug}/lane`, { method: "PUT", headers: admin, json: { variant: "mainstream", weights: { source: "huggingface:other/repo" } } });
    const r = await verify(stale.id);
    expect(r.status).toBe(409);
    expect((await r.json()).error.type).toBe("claim_stale");
    await declareSource(MODEL);
  });
});

describe("royalty registration on chain", () => {
  test("when a royalty contract is configured the recipient is registered first, and a failure leaves the claim to retry", async () => {
    const calls: unknown[][] = [];
    let fail = true;
    const address = h.chain.address.bind(h.chain);
    h.chain.address = ((name: string) => (name === "royalty" ? "0x00000000000000000000000000000000000c0006" : address(name))) as never;
    h.chain.registerRoyalty = (async (...args: unknown[]) => {
      calls.push(args);
      if (fail) throw new Error("rpc unavailable");
      return { hash: "0x" + "77".repeat(32), receipt: {} };
    }) as never;
    try {
      const c = (await (await issue({ model: MODEL.slug, address: ALICE })).json()).data;
      publish(MODEL.hf, `${c.challenge}\n`);
      const before = (await modelRow()).creator;
      const failed = await verify(c.id);
      expect(failed.status).toBe(502);
      expect((await failed.json()).error.type).toBe("chain_failed");
      expect((await modelRow()).creator).toBe(before); // nothing recorded off chain either
      expect((await h.ctx.db.select().from(laneClaims).where(eq(laneClaims.id, c.id)))[0].status).toBe("pending");

      fail = false;
      const ok = await verify(c.id);
      expect(ok.status).toBe(200);
      expect((await ok.json()).data).toMatchObject({ status: "verified", onchain_tx: "0x" + "77".repeat(32), royalty_bps: 500 });
      expect(calls.at(-1)).toEqual([keccak256(toBytes(MODEL.slug)), ALICE, 500]);
      expect((await modelRow()).creator).toBe(ALICE);
    } finally {
      delete (h.chain as any).address;
      delete (h.chain as any).registerRoyalty;
    }
  });

  test("the default rate is configurable and capped at the contract's maximum", async () => {
    const custom = await startRouter({ env: { HF_BASE_URL: HUB, DEFAULT_ROYALTY_BPS: "9000" }, providers: [{ id: "vendor", name: "Vendor", models: [MODEL] }] });
    try {
      custom.ctx.hfFetch = fakeHub;
      await custom.request(`/api/v1/models/${MODEL.slug}/lane`, { method: "PUT", headers: admin, json: { variant: "mainstream", weights: { source: `huggingface:${MODEL.hf}` } } });
      const c = (await (await custom.request("/api/v1/creators/claims", { method: "POST", json: { model: MODEL.slug, address: ALICE } })).json()).data;
      expect(c.royalty_bps).toBe(2000);
      publish(MODEL.hf, `${c.challenge}\n`);
      const r = await custom.request(`/api/v1/creators/claims/${c.id}/verify`, { method: "POST" });
      expect(r.status).toBe(200);
      expect((await custom.ctx.db.select().from(models).where(eq(models.id, MODEL.slug)))[0].royaltyBps).toBe(2000);
    } finally {
      await custom.close();
    }
  });
});

describe("abuse limits", () => {
  test("challenges for one model are rate limited", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await issue({ model: LIMITED.slug, address: ALICE })).status);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  test("verification attempts for one claim are rate limited", async () => {
    const c = (await (await issue({ model: MODEL.slug, address: ALICE })).json()).data;
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await verify(c.id)).status);
    expect(codes.slice(0, 20).every((s) => s === 403 || s === 400)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
  });
});
