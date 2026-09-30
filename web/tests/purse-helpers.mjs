// Stand-ins for the parts of a browser and of the router that the private-tokens flow talks to. Not a test file
// (the runner only picks up *.test.mjs); the tests import what they need.
//
//   fakeRouter   the routes the flow calls, with a real RSA blind signer, per-key balances, idempotent purchases and
//                switches for the failures a real router can produce (a lost response, a rate limit, a closed epoch)
//   fakeIndexedDB / fakeStorage / fakeWallet   the browser side, each with switches for its failure modes
import crypto from "node:crypto";
import { ApiError } from "../lib/api.js";
import { fromHex, toBase64Url, toHex, concat } from "../lib/blind-rsa.js";

// ---- the router --------------------------------------------------------------------------------------------------

const PSS_ALG = "303d06092a864886f70d01010a3030a00d300b0609608648016503040202a11a301806092a864886f70d010108300b0609608648016503040202a203020130";
const der = (tag, body) => {
  const len = body.length < 0x80 ? Uint8Array.of(body.length) : body.length < 0x100 ? Uint8Array.of(0x81, body.length) : Uint8Array.of(0x82, body.length >> 8, body.length & 0xff);
  return concat(Uint8Array.of(tag), len, body);
};
const derInt = (b) => der(0x02, b[0] & 0x80 ? concat(Uint8Array.of(0), b) : b);
const spkiOf = (n, e) => der(0x30, concat(fromHex(PSS_ALG), der(0x03, concat(Uint8Array.of(0), der(0x30, concat(derInt(n), derInt(e)))))));

const issuerCache = new Map();
/** Three issuer keys (1000, 10000 and 100000 units) per generation, generated once per process. A new generation is what a new epoch brings. */
export function issuerKeys(generation = 0) {
  if (!issuerCache.has(generation))
    issuerCache.set(generation, [1000, 10000, 100000].map((denomination) => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const spki = spkiOf(Buffer.from(jwk.n, "base64url"), Buffer.from(jwk.e, "base64url"));
    return { denomination, generation, spki, keyId: crypto.createHash("sha256").update(spki).digest("hex"), privateKey, publicKey, n: BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex")) };
    }));
  return issuerCache.get(generation);
}

const UNIT_PICO = 2_000_000n; // $0.000002 per unit
export const valuePico = (denomination) => BigInt(denomination) * UNIT_PICO;
const picoText = (p) => {
  const whole = p / 10n ** 12n;
  const frac = (p % 10n ** 12n).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const usdPico = (x) => BigInt(Math.round(Number(x) * 1e6)) * 1_000_000n;
const rand = (n) => crypto.randomBytes(n).toString("hex");

export const CREDITS = "0x" + "c1".repeat(20);
export const USDG = "0x" + "d2".repeat(20);
export const ESCROW = "0x" + "e3".repeat(20);
export const ANYR_OFFICIAL = "0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a";

export function fakeRouter(opts = {}) {
  const epoch = 2900;
  const now = opts.now ?? Date.now();
  const s = {
    keys: new Map(), // secret -> { hash, account, disabled, management }
    byHash: new Map(),
    accounts: new Map(), // account -> pico
    escrowDeposits: new Map(), // address -> [{ id, symbol, amount, status, stage, credited_usd }]
    purchases: new Map(), // digest of the request -> response
    charged: 0, // how many purchases were charged (a replay does not count)
    calls: [],
    hooks: {},
    closedEpoch: false,
    generation: 0,
    maxBatch: opts.maxBatch ?? 32,
    dayCapPico: opts.dayCapPico ?? null,
    spentToday: 0n,
    purchaseCalls: 0,
    anyrPrice: opts.anyrPrice === undefined ? 0.0002 : opts.anyrPrice, // credit per token; null: no price
  };
  const err = (status, message, type, metadata) => new ApiError(status, message, type, metadata);
  const auth = (key) => {
    const k = key && s.keys.get(key);
    if (!k) throw err(401, "Invalid API key.", "invalid_api_key");
    if (k.disabled) throw err(401, "This API key is disabled.", "key_disabled");
    return k;
  };
  const balance = (account) => s.accounts.get(account) ?? 0n;
  const directory = () => ({
    token_type: 2,
    scheme: "RSABSSA-SHA384-PSS-Deterministic",
    modulus_bits: 2048,
    issuer_name: "router.example",
    challenge: "AAA",
    challenge_digest: crypto.createHash("sha256").update("router.example").digest("hex"),
    unit_price_usd: "0.000002",
    epoch_seconds: 604800,
    redeem_grace_seconds: 604800,
    max_batch: s.maxBatch,
    epoch,
    now: new Date(now).toISOString(),
    keys: issuerKeys(s.generation).map((i) => ({
      token_key_id: i.keyId,
      token_key: toBase64Url(i.spki),
      epoch,
      denomination: i.denomination,
      value_usd: picoText(valuePico(i.denomination)),
      unit_price_usd: "0.000002",
      status: s.closedEpoch ? "closed" : "issuing",
      not_before: new Date(now - 86_400_000).toISOString(),
      issue_until: new Date(now + 6 * 86_400_000).toISOString(),
      redeem_until: new Date(now + 13 * 86_400_000).toISOString(),
      revoked_at: null,
      issued: 0,
      redeemed: 0,
    })),
    commitments: [],
  });
  const newKey = (account, name, management = true) => {
    const secret = "sk-ar-v1-" + rand(32);
    const hash = rand(32);
    const rec = { hash, account, name, disabled: false, management, chainKeyHash: "0x" + rand(32) };
    s.keys.set(secret, rec);
    s.byHash.set(hash, rec);
    return { secret, rec };
  };
  const walletAccount = (address) => `w_${address.toLowerCase().slice(2)}`;

  async function route(path, { key, method = "GET", body } = {}) {
    s.calls.push({ method, path, key: key ?? null, body });
    const before = s.hooks.before?.(method, path, body);
    if (before instanceof Promise) await before;
    const url = new URL(path, "http://router.example");
    const p = url.pathname;
    if (method === "GET" && p === "/api/v1/status")
      return {
        data: {
          chain: { chain_id: 4663, public_rpc: "https://rpc.example", explorer: "https://explorer.example" },
          escrow: { enabled: true, tokens: ["ANYR"], haircut_bps: 300, anyr: { symbol: "ANYR", address: opts.anyrAddress ?? ANYR_OFFICIAL, decimals: 18, haircut_bps: 300, max_usd_per_deposit: 500, price_source: "twap", twap_minutes: 30 } },
          lanes: { unlinkable: { available: true, via: ["onion"] } },
          onion: null,
        },
      };
    if (method === "GET" && p === "/api/v1/blind/keys") {
      if (opts.blindOff) throw err(404, "Not found.", "not_found");
      return { data: directory() };
    }
    if (method === "POST" && p === "/api/v1/keys" && !key) {
      const account = `k_${rand(8)}`;
      const { secret, rec } = newKey(account, body?.name);
      return { data: { hash: rec.hash, chain_key_hash: rec.chainKeyHash, name: body?.name }, key: secret, deposit: { chain: 4663, token: USDG, credits_contract: opts.noCredits ? null : CREDITS, key_hash: rec.chainKeyHash, key_address: "0x" + rand(20) } };
    }
    if (method === "GET" && p === "/api/v1/escrow") return { data: { enabled: true, address: ESCROW, chain_id: 4663, expected_credit_delay_s: 120, head_block: "100", credit_block: "90", anyr: null, tokens: [] } };
    if (method === "GET" && p === "/api/v1/escrow/anyr/price") {
      if (s.anyrPrice === null) return { data: { enabled: true, available: false, symbol: "ANYR", reason: { code: "source_unreachable", message: "no price" } } };
      return { data: { enabled: true, available: true, symbol: "ANYR", address: ANYR_OFFICIAL, decimals: 18, source: "twap", window_minutes: 30, haircut_bps: 300, max_usd_per_deposit: 500, credit_usd_per_token: s.anyrPrice, price_usd: s.anyrPrice / 0.97, spot_usd: s.anyrPrice, average_usd: s.anyrPrice, window_seconds: 1800, swaps: 12, updated_at: new Date(now).toISOString() } };
    }
    if (method === "POST" && p === "/api/v1/auth/wallet/challenge") return { data: { nonce: rand(24), message: `Anyroute wallet sign-in\nWallet: ${body.address}`, expires_at: new Date(now + 300_000).toISOString() } };
    if (method === "POST" && p === "/api/v1/auth/wallet") {
      const { secret, rec } = newKey(walletAccount(body.address), body.name);
      return { data: { hash: rec.hash, name: body.name, management: true }, key: secret };
    }
    // everything below needs a key
    const k = auth(key);
    if (method === "GET" && p === "/api/v1/key") return { data: { hash: k.hash, balance: Number(balance(k.account)) / 1e12, deposit: k.account.startsWith("k_") ? { chain: 4663, token: USDG, credits_contract: CREDITS, key_hash: k.chainKeyHash } : { chain: 4663, token: USDG, credits_contract: CREDITS, key_hash: k.chainKeyHash } } };
    if (method === "GET" && p === "/api/v1/credits") return { data: { balance: Number(balance(k.account)) / 1e12, available: Number(balance(k.account)) / 1e12, currency: "USDG" } };
    if (method === "POST" && p === "/api/v1/credits/deposit-tx") return { data: { chain: 4663, key_hash: k.chainKeyHash, transactions: [{ to: USDG, data: "0x095ea7b3", description: `Approve ${body.amount} USDG for Credits` }, { to: CREDITS, data: "0xe2bbb158", description: `Deposit ${body.amount} USDG to this key` }] } };
    if (method === "GET" && p === "/api/v1/escrow/deposits") {
      const wallet = k.account.startsWith("w_") ? `0x${k.account.slice(2)}` : null;
      return { data: { enabled: true, wallet, deposits: wallet ? s.escrowDeposits.get(k.account) ?? [] : [] } };
    }
    const patch = /^\/api\/v1\/keys\/([0-9a-f]+)$/.exec(p);
    if (method === "PATCH" && patch) {
      const target = s.byHash.get(patch[1]);
      if (!target || target.account !== k.account) throw err(404, "Key not found.", "not_found");
      if (s.hooks.patchFails) throw err(0, "The Anyroute API could not be reached.", "unreachable");
      if (body.disabled !== undefined) target.disabled = body.disabled;
      return { data: { hash: target.hash, disabled: target.disabled } };
    }
    if (method === "POST" && p === "/api/v1/blind/purchase") return purchase(k, body);
    throw err(404, `No route for ${method} ${p}`, "not_found");
  }

  async function purchase(k, body) {
    s.purchaseCalls++;
    const n = s.purchaseCalls;
    const hook = s.hooks.purchase?.(n, body);
    if (hook instanceof Promise) await hook;
    const issuer = [...issuerKeys(0), ...(issuerCache.has(1) ? issuerKeys(1) : [])].find((i) => i.keyId === body.token_key_id);
    if (!issuer) throw err(404, "Unknown token key.", "unknown_token_key");
    if (s.closedEpoch || issuer.generation !== s.generation) throw err(409, "That key's epoch has ended and no longer issues tokens.", "epoch_closed", { epoch });
    const blinded = body.blinded_msgs.map((m) => Buffer.from(m, "base64url"));
    if (!blinded.length || blinded.length > s.maxBatch) throw err(400, `Ask for between 1 and ${s.maxBatch} tokens per purchase.`, "invalid_request");
    const digest = crypto.createHash("sha256").update([k.account, issuer.keyId, ...blinded.map((b) => b.toString("hex"))].join("|")).digest("hex");
    let response = s.purchases.get(digest);
    if (!response) {
      const cost = BigInt(blinded.length) * valuePico(issuer.denomination);
      if (cost > balance(k.account)) throw err(402, "Insufficient credits.", "insufficient_credits", { required_usd: Number(cost) / 1e12, available_usd: Number(balance(k.account)) / 1e12 });
      if (s.dayCapPico !== null && s.spentToday + cost > s.dayCapPico) throw err(429, "Daily purchase cap reached for this account.", "purchase_cap", { daily_cap_usd: Number(s.dayCapPico) / 1e12 });
      const signatures = blinded.map((b) => {
        if (BigInt("0x" + b.toString("hex")) >= issuer.n) throw err(400, "not a valid blinded message", "invalid_blinded_message");
        return toBase64Url(crypto.privateDecrypt({ key: issuer.privateKey, padding: crypto.constants.RSA_NO_PADDING }, b));
      });
      s.accounts.set(k.account, balance(k.account) - cost);
      s.spentToday += cost;
      s.charged++;
      response = { data: { token_key_id: issuer.keyId, epoch, denomination: issuer.denomination, count: blinded.length, cost_usd: picoText(cost), replayed: false, signatures } };
      s.purchases.set(digest, response);
    } else response = { data: { ...response.data, replayed: true } };
    const after = s.hooks.afterPurchase?.(n);
    if (after instanceof Promise) await after;
    return response;
  }

  return {
    api: route,
    state: s,
    get issuers() {
      return issuerKeys(s.generation);
    },
    /** Credit whichever account a secret belongs to, in dollars. */
    credit(secretOrAccount, usd) {
      const account = s.keys.get(secretOrAccount)?.account ?? secretOrAccount;
      s.accounts.set(account, balance(account) + usdPico(usd));
    },
    balanceOf: (secretOrAccount) => balance(s.keys.get(secretOrAccount)?.account ?? secretOrAccount),
    /** An escrow deposit for a wallet: credited at once when `stage` is "credited". */
    escrow(address, { id = rand(6), amount = "1000", usd = 0.6, stage = "credited", symbol = "ANYR" } = {}) {
      const account = walletAccount(address);
      const list = s.escrowDeposits.get(account) ?? [];
      list.unshift({ id, tx_hash: "0x" + rand(32), block: "95", symbol, amount, status: stage === "credited" ? "credited" : "pending_finality", stage, credited_usd: stage === "credited" ? usd : null, at: new Date(now).toISOString(), note: null });
      s.escrowDeposits.set(account, list);
      if (stage === "credited") s.accounts.set(account, balance(account) + usdPico(usd));
      return id;
    },
    walletAccount,
    keyRecord: (secret) => s.keys.get(secret),
    networkError: () => err(0, "The Anyroute API could not be reached. Check your connection and try again.", "unreachable"),
    apiError: err,
    close() {
      s.closedEpoch = true;
    },
  };
}

// ---- the browser -----------------------------------------------------------------------------------------------

/** sessionStorage with switches for the ways it fails. */
export function fakeStorage(flags = {}) {
  const map = new Map();
  const throwing = (name) => {
    const e = new Error("blocked");
    e.name = name;
    return e;
  };
  return {
    flags,
    map,
    getItem(k) {
      if (flags.throwOnGet) throw throwing("SecurityError");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (flags.quota) throw throwing("QuotaExceededError");
      if (flags.throwOnSet) throw throwing("SecurityError");
      map.set(k, String(v));
    },
    removeItem(k) {
      if (flags.throwOnRemove) throw throwing("SecurityError");
      map.delete(k);
    },
  };
}

/** The slice of IndexedDB the purse uses, with atomic transactions and switches for the failures browsers produce. */
export function fakeIndexedDB(flags = {}) {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const domError = (name, message) => Object.assign(new Error(message ?? name), { name });
  return {
    flags,
    dbs,
    open(name, version) {
      const req = { result: null, error: null };
      later(() => {
        if (flags.failOpen) {
          req.error = domError("UnknownError", "open failed");
          req.onerror?.();
          return;
        }
        if (flags.blocked) {
          req.onblocked?.();
          return;
        }
        if (flags.hangOpen) return;
        let rec = dbs.get(name);
        const fresh = !rec;
        if (!rec) {
          rec = { version, stores: new Map() };
          dbs.set(name, rec);
        }
        const db = {
          objectStoreNames: { contains: (n) => rec.stores.has(n) },
          createObjectStore(n, { keyPath }) {
            rec.stores.set(n, { keyPath, rows: new Map() });
          },
          transaction(names, mode) {
            if (flags.failTransaction) throw domError("InvalidStateError", "the database connection is closing");
            const staged = new Map(names.map((n) => [n, new Map(rec.stores.get(n).rows)]));
            const tx = { error: null, aborted: false, failed: false };
            tx.objectStore = (n) => {
              const info = rec.stores.get(n);
              const rows = staged.get(n);
              const request = (fn) => {
                const r = { result: undefined, error: null };
                later(() => {
                  if (tx.aborted) return;
                  r.result = fn();
                  r.onsuccess?.();
                });
                return r;
              };
              return {
                put(v) {
                  if (mode === "readonly") throw domError("ReadOnlyError");
                  if (flags.quotaOnPut !== undefined && (flags.putCount = (flags.putCount ?? 0) + 1) > flags.quotaOnPut) {
                    tx.failed = true;
                    tx.error = domError("QuotaExceededError", "quota");
                    return request(() => undefined);
                  }
                  rows.set(v[info.keyPath], structuredClone(v));
                  return request(() => v[info.keyPath]);
                },
                get: (key) => request(() => structuredClone(rows.get(key))),
                getAll: () => request(() => [...rows.values()].map((v) => structuredClone(v))),
                delete(key) {
                  rows.delete(key);
                  return request(() => undefined);
                },
                clear() {
                  rows.clear();
                  return request(() => undefined);
                },
              };
            };
            tx.abort = () => {
              tx.aborted = true;
            };
            // Auto-commit once the callbacks queued by this tick have run, as IndexedDB does.
            later(() =>
              later(() => {
                if (tx.aborted) return;
                if (tx.failed || (flags.abortWrites && mode === "readwrite")) {
                  tx.aborted = true;
                  tx.error ??= domError("AbortError", "aborted");
                  tx.onabort?.();
                  return;
                }
                for (const [n, rows] of staged) rec.stores.get(n).rows = rows;
                tx.oncomplete?.();
              }),
            );
            return tx;
          },
          close() {},
        };
        req.result = db;
        if (fresh || version > rec.version) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

/** A wallet: records what it was asked, and can refuse. */
export function fakeWallet(flags = {}) {
  const w = {
    address: flags.address ?? "0x" + "ab".repeat(20),
    flags,
    calls: [],
    hasWallet: () => flags.hasWallet !== false,
    async connect() {
      w.calls.push("connect");
      if (flags.rejectConnect) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      return w.address;
    },
    async ensureChain(chain) {
      w.calls.push(["ensureChain", chain.id]);
    },
    async personalSign(address, message) {
      w.calls.push("personalSign");
      if (flags.rejectSign) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      return flags.sign ? flags.sign(message) : "0x" + "11".repeat(65);
    },
    async sendTransactions(from, txs, onStep) {
      w.calls.push(["send", from, txs.map((t) => t.to)]);
      for (const [i, t] of txs.entries()) onStep?.(`${i + 1}/${txs.length}: ${t.description}`);
      if (flags.rejectSend) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      if (flags.onSend) await flags.onSend(txs);
      return txs.map(() => "0x" + "aa".repeat(32));
    },
  };
  return w;
}

export const hexOf = toHex;
