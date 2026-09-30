import { blindTokens, fetchDirectory, finalizeTokens, issuingKey, type DirectoryKey } from "../../client/src/blind.ts";
import { bytesToBase64Url } from "../../client/src/bytes.ts";
import type { StoredToken, TokenStore } from "./store.ts";

// Buying blind tokens with an API key. The purchase names your account (that is what the key is); the tokens it
// returns are blinded, so the router cannot tell which purchase a token it is later shown came from. This is the
// client side of POST /api/v1/blind/purchase, in @anyroute/client's blind module, run in batches of the size the router
// allows, saving each batch as it arrives.

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class PurchaseError extends Error {
  override name = "PurchaseError";
}

export type PurchaseOptions = {
  fetch: Fetch;
  /** Where the router is: the onion URL (http://<address>) or, with --clearnet, its https URL. */
  baseUrl: string;
  apiKey: string;
  denomination: number;
  count: number;
  store: TokenStore;
  log?: (line: string) => void;
  /** Attempts for one batch on a lost connection. The router treats a repeated purchase as the same one, so it never charges twice. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};
export type Purchased = { count: number; costUsd: string; denomination: number; valueUsd: string; redeemUntil: string };

/** The router's own error text, with the key removed in case it was echoed back. */
const scrub = (text: string, apiKey: string) => text.split(apiKey).join("[key]").slice(0, 300);

export async function purchase(o: PurchaseOptions): Promise<Purchased> {
  const log = o.log ?? (() => undefined);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = o.baseUrl.replace(/\/$/, "");
  const dir = await fetchDirectory(base, o.fetch);
  let key: DirectoryKey;
  try {
    key = issuingKey(dir, o.denomination);
  } catch {
    const open = dir.keys.filter((k) => k.status === "issuing").map((k) => k.denomination);
    throw new PurchaseError(`The router is not issuing ${o.denomination}-unit tokens right now.${open.length ? ` It is issuing: ${[...new Set(open)].join(", ")}.` : ""}`);
  }
  const batch = Math.max(1, Math.min(dir.max_batch, 256));
  let done = 0;
  let cost = 0;
  while (done < o.count) {
    const n = Math.min(batch, o.count - done);
    const pending = await blindTokens(key, dir.challenge_digest, n);
    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ token_key_id: key.token_key_id, blinded_msgs: pending.map((p) => bytesToBase64Url(p.blindedMsg)) }),
    };
    let json: { data?: { signatures: string[]; cost_usd: string }; error?: { message?: string } } | undefined;
    let status = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await o.fetch(`${base}/api/v1/blind/purchase`, request);
        status = res.status;
        json = (await res.json().catch(() => undefined)) as typeof json;
        if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
      } catch (e) {
        if (attempt >= (o.attempts ?? 3)) throw new PurchaseError(`The connection failed while buying: ${(e as Error).message}. Batches that finished are saved. The last one may have been charged without its tokens reaching you; check the credits on your key before buying again.`);
      }
      if (attempt >= (o.attempts ?? 3)) break;
      await sleep(2_000 * attempt);
    }
    if (status !== 200 || !json?.data) throw new PurchaseError(`The router refused the purchase (${status}): ${scrub(json?.error?.message ?? "no reason given", o.apiKey)}`);
    const tokens = await finalizeTokens(key, pending, json.data.signatures);
    const now = new Date().toISOString();
    const stored: StoredToken[] = tokens.map((token) => ({ token, key_id: key.token_key_id, denomination: key.denomination, epoch: key.epoch, value_usd: key.value_usd, redeem_until: key.redeem_until, bought_at: now }));
    await o.store.add(stored);
    done += n;
    cost += Number(json.data.cost_usd) || 0;
    log(`Bought ${done} of ${o.count}.`);
  }
  return { count: done, costUsd: cost.toFixed(4), denomination: key.denomination, valueUsd: key.value_usd, redeemUntil: key.redeem_until };
}
