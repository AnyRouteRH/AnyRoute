import type { Hono } from "hono";
import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { picoToUsdString } from "../lib/money.ts";
import { requireKey, requireRole } from "../api/auth.ts";
import { readJson } from "../api/common.ts";
import { purchaseTokens } from "./purchase.ts";
import { tokenValue } from "./redeem.ts";
import { b64url, decodeBase64 } from "./token.ts";
import { epochCommitment } from "./issuer.ts";

// GET  /api/v1/blind/keys      the issuer keys, the challenge tokens must carry, and prices (public)
// POST /api/v1/blind/purchase  buy tokens with credits (a router API key)
// Registered only when ANYROUTE_FEATURE_BLIND is on.
export function blindRoutes(app: Hono, ctx: Ctx) {
  const issuer = ctx.blind!;
  const cfg = ctx.cfg.blind;

  app.get("/api/v1/blind/keys", async (c) => {
    const keys = await issuer.publicKeys();
    const issued = new Map(keys.map((k) => [k.keyId, k.issued]));
    const redeemed = await issuer.redeemedCounts();
    const epoch = issuer.epochAt();
    const byEpoch = new Map<number, { denomination: number; keyId: string }[]>();
    for (const k of keys) byEpoch.set(k.epoch, [...(byEpoch.get(k.epoch) ?? []), { denomination: k.denomination, keyId: k.keyId }]);
    c.header("cache-control", "no-store");
    return c.json({
      data: {
        token_type: 2,
        scheme: "RSABSSA-SHA384-PSS-Deterministic",
        modulus_bits: 2048,
        issuer_name: cfg.issuerName,
        // The TokenChallenge every token must carry (RFC 9577 section 2.1) and its SHA-256, so a client can build
        // token_input without guessing the router's host name.
        challenge: b64url(issuer.challenge),
        challenge_digest: Buffer.from(issuer.challengeDigest).toString("hex"),
        unit_price_usd: picoToUsdString(cfg.unitPricePico),
        epoch_seconds: cfg.epochSeconds,
        redeem_grace_seconds: cfg.redeemGraceSeconds,
        max_batch: cfg.maxBatch,
        epoch,
        now: new Date(issuer.now()).toISOString(),
        keys: keys.map((k) => ({
          token_key_id: k.keyId,
          token_key: k.spki, // base64url SubjectPublicKeyInfo; token_key_id is its SHA-256
          epoch: k.epoch,
          denomination: k.denomination,
          value_usd: picoToUsdString(tokenValue(ctx, k.denomination)),
          status: issuer.status(k),
          not_before: k.validFrom.toISOString(),
          issue_until: k.issueUntil.toISOString(),
          redeem_until: k.redeemUntil.toISOString(),
          revoked_at: k.revokedAt?.toISOString() ?? null,
          issued: issued.get(k.keyId) ?? 0,
          redeemed: redeemed.get(k.keyId) ?? 0,
        })),
        // keccak256(abi.encode(epoch, denominations, keyIds)) per epoch: the value BlindIssuer.commitEpoch anchors on chain.
        commitments: [...byEpoch].filter(([, ks]) => ks.length === cfg.denominations.length).map(([e, ks]) => ({ epoch: e, commitment: epochCommitment(e, ks).commitment })),
      },
    });
  });

  app.post("/api/v1/blind/purchase", async (c) => {
    c.header("cache-control", "no-store");
    const caller = await requireKey(ctx, c.req.header("authorization"));
    await requireRole(ctx, caller, ["owner", "admin", "member"]);
    // Tokens work for every model, so a key limited to some models must not be able to mint them.
    if (caller.allowedModels?.length) fail(403, "A key restricted to specific models cannot buy blind tokens.", "model_not_allowed");
    const body = await readJson(c);
    if (typeof body.token_key_id !== "string") fail(400, "`token_key_id` is required (see GET /api/v1/blind/keys).", "invalid_request");
    if (!Array.isArray(body.blinded_msgs) || body.blinded_msgs.some((m) => typeof m !== "string")) fail(400, "`blinded_msgs` must be an array of base64url strings.", "invalid_request");
    const blinded = (body.blinded_msgs as string[]).map((m, i) => decodeBase64(m) ?? fail(400, `blinded_msgs[${i}] is not base64url.`, "invalid_blinded_message"));
    const p = await purchaseTokens(ctx, caller, { tokenKeyId: body.token_key_id, blinded });
    return c.json({
      data: {
        token_key_id: p.key.keyId,
        epoch: p.key.epoch,
        denomination: p.key.denomination,
        count: p.count,
        cost_usd: picoToUsdString(p.cost),
        replayed: p.replayed,
        signatures: p.signatures.map((s) => b64url(s)), // signatures[i] answers blinded_msgs[i]
      },
    });
  });
}
