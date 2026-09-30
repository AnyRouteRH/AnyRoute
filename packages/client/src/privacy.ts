// "What we saw": a plain-English privacy label for one answer, computed from its signed receipt.
//
// `privacyLabel(receipt)` takes a receipt the caller has already verified (see verifyReceipt) and says who could read
// the prompt, who saw the caller's network address, how the call was paid, what the router kept and what hardware
// answered. It is derived from the fields the receipt signs and from nothing else: a field the receipt does not carry is
// reported as not recorded, never assumed to be favourable. The router computes the same label for
// GET /api/v1/receipts/{id}/privacy; the only inputs the router adds are the TEE type of the attestation the receipt
// cites (`teeKind`) and how it serves the unlinkable lane (`unlinkableTransports`), which a receipt does not carry.
// The label does not verify anything: a receipt that was not verified says whatever its forger wrote.

import type { Fetch } from "./types.js";

// ==== shared with packages/client/src/privacy.ts: everything between these markers is identical there (begin) ====

export type Lane = "public" | "attested" | "unlinkable";
export type Disclosure = "attested" | "policy" | "vendor-forwarded";
export type Transport = "ohttp" | "onion";

export type LabelOptions = {
  /** The TEE type from the router's attestation record for the receipt's `attestation` hash. The receipt does not name it. */
  teeKind?: string | null;
  /** How this router serves lane "unlinkable" (its configuration). Omitted: the label says Tor or an independent relay. */
  unlinkableTransports?: Transport[];
  /** Where the verify page lives. Default: the receipt's own `router` field. */
  baseUrl?: string | null;
};

export type ProviderAccess = "attested_enclave" | "documented_policy" | "provider" | "unproven_provider" | "unknown" | "none";
export type PaymentKind = "key_balance" | "pay_with_stock_token" | "own_provider_key" | "blind_token" | "wallet_balance" | "x402" | "cache_hit" | "unknown";

export type OutputKind = "text" | "image" | "video" | "audio" | "call" | "compute" | "unknown";
export type OutputLabel = { unit_type: string; units: number | null; kind: OutputKind; text: string };

export type PrivacyLabel = {
  receipt_id: string | null;
  lane: Lane | null;
  label: {
    output: OutputLabel;
    prompt_readers: {
      /** Always true: the router reads the prompt in memory to route it, on every lane. */
      router: true;
      provider: { id: string | null; access: ProviderAccess; reply_withheld: boolean | null };
      /** Provider ids named in an aggregate council receipt; individual receipts describe their access. */
      participants?: string[];
      text: string;
    };
    network: {
      hidden: boolean;
      via: "tor" | "relay" | "tor_or_relay" | null;
      /** Whether AnyRoute's software wrote the client address to a table. Null: unfamiliar output type. */
      stored: false | null;
      /** Whether the address was held as a rate-limit counter key: for about a minute, or not at all, or possibly. */
      counter: "none" | "about_a_minute" | "possible";
      text: string;
    };
    payment: { kind: PaymentKind; identifies: "api_key" | "wallet" | "spent_token" | null; text: string };
    stored: {
      /** These describe the generation database, not caches, batches or provider retention. Null: not established. */
      prompt_text: false | null;
      reply_text: false | null;
      client_address: false | null;
      fingerprints: boolean;
      linked_to: "api_key" | "wallet" | "nobody" | "unknown";
      /** A copy of the reply in the opt-in response cache: never, only if the request asked for it, or this answer was one. */
      cache: "never" | "only_if_requested" | "cache_hit" | "not_recorded";
      records: string[];
      public_by_id: true;
      text: string;
    };
    hardware: {
      attested: boolean;
      tee: string | null;
      gpu_attested: boolean;
      verified_by: "gateway_receipt" | "router_attestation" | null;
      development_report: boolean;
      text: string;
    };
  };
  /** Three to five short lines a person who is not a developer can read. */
  summary: string[];
  /** The same in one line, for a chat message. */
  short: string;
  verify_url: string | null;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_HASH = /^0x[0-9a-fA-F]{64}$/;
const CONTENT_HASH = /^(?:0x)?[0-9a-fA-F]{64}$/;
const LANES: readonly string[] = ["public", "attested", "unlinkable"];
const DISCLOSURES: readonly string[] = ["attested", "policy", "vendor-forwarded"];
/** Text from a receipt that goes into a sentence: printable characters only, and short. */
const plain = (v: unknown, max = 160): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = s.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return t || null;
};

const TEE_NAMES: Record<string, string> = {
  tdx: "Intel TDX",
  snp: "AMD SEV-SNP",
  "nvidia-cc": "NVIDIA confidential computing",
  dev: "development report (not hardware)",
};
const teeName = (kind: string | null | undefined): string | null => {
  const k = plain(kind, 40);
  return k ? (TEE_NAMES[k.toLowerCase()] ?? k) : null;
};

// Unit types describe metering, not the route or every input modality (a token call can contain images).
// Do not infer search, fine-tuning, media fetching or retention from a billing unit alone.
const UNIT_KINDS: Record<string, OutputKind> = { token: "text", image_mp: "image", video_sec: "video", audio_sec: "audio", call: "call", gpu_sec: "compute" };
const OUTPUT_NAMES: Record<OutputKind, string> = { text: "Text / embeddings", image: "Image", video: "Video", audio: "Audio", call: "Tool / search call", compute: "GPU work / fine-tuning", unknown: "Output" };
const count = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
function outputOf(p: Obj): OutputLabel {
  const usage = obj(p.usage);
  const raw = usage && "unit_type" in usage ? usage.unit_type : "unit_type" in p ? p.unit_type : "token";
  const unit_type = plain(raw, 40) ?? "unknown";
  const kind = Object.hasOwn(UNIT_KINDS, unit_type) ? UNIT_KINDS[unit_type]! : "unknown";
  const units = count(usage?.units);
  const description = {
    text: "Token metering covers chat, embeddings, RAG, Responses, Messages and council calls. It does not identify all input modalities; a request can also include media references or tool data.",
    image: "Image metering. The router handles request text and supplied image data or references in memory; a reference does not show that the router fetched the image bytes.",
    video: "Video metering. The router handles request text and supplied video data or references in memory; a reference does not show that the router fetched the video bytes.",
    audio: "Audio metering covers voice input or output. The router handles request text and supplied audio data or references in memory; a reference does not show that the router fetched the audio bytes.",
    call: "Call metering can cover tools or search. A call unit alone does not identify the operation or show that a tool was executed.",
    compute: "GPU time can cover computation or fine-tuning. The receipt does not establish whether training data, model weights or job artifacts were retained.",
    unknown: "The receipt uses an unfamiliar or invalid unit type. It does not establish the content handled or its retention; no modality or retention guarantee is inferred.",
  }[kind];
  return { unit_type, units, kind, text: `${OUTPUT_NAMES[kind]}: ${units === null ? "quantity not recorded" : units} (${unit_type}). ${description}` };
}

/** The receipt payload, whether given as the envelope (`{ payload, ... }`) or as the payload itself. */
function payloadOf(receipt: unknown): { id: string | null; p: Obj } {
  const r = obj(receipt) ?? {};
  const inner = obj(r.payload);
  if (inner) return { id: str(inner.id) ?? str(r.id), p: inner };
  return { id: str(r.id), p: r };
}

/** The label for one receipt. `receipt` is a receipt envelope, a receipt payload, or a stored generation's `receipt`. */
export function privacyLabel(receipt: unknown, opts: LabelOptions = {}): PrivacyLabel {
  const { id: rawId, p } = payloadOf(receipt);
  const output = outputOf(p);
  const id = rawId && RECEIPT_ID.test(rawId) ? rawId : null;
  const lane = (LANES.includes(p.lane as string) ? p.lane : null) as Lane | null;
  const disclosure = (DISCLOSURES.includes(p.disclosure as string) ? p.disclosure : null) as Disclosure | null;
  const mode = plain(p.mode, 20);
  const providerRaw = str(p.provider);
  const provider = providerRaw && PROVIDER_ID.test(providerRaw) ? providerRaw : null;
  const simulated = p.attestation_simulated === true;
  const ua = obj(p.upstream_attestation);
  // A line of a batch (POST /api/v1/batches): its request and reply are kept sealed outside the database until the batch's results expire.
  const batch = obj(p.batch) !== null;
  const cached = mode === "cache";
  const pool = provider === "cache";
  const fromCache = cached || pool;

  // ---- hardware -------------------------------------------------------------------------------------------------
  // "Attested" needs the receipt to say the router served it under the attested class, and, for an attested gateway,
  // the gateway's own signed receipt to have checked out (the router refuses to deliver an attested-lane reply when it
  // did not). A development report is never hardware.
  const gatewayOk = ua ? ua.attested === true : null;
  const enclave = !fromCache && disclosure === "attested" && !simulated && gatewayOk !== false;
  const gpu = enclave && ua?.gpu_attested === true;
  const withheld: boolean | null = ua && gatewayOk === false ? (lane === "attested" || lane === "unlinkable" || p.private === true ? true : null) : false;
  const reason = (ua ? plain(ua.reason) : null) ?? (simulated ? "a development report, not hardware" : null);
  const tee = enclave ? teeName(opts.teeKind) : null;
  const teeBits = tee ? `${tee}${gpu ? " with GPU attestation" : ""}` : gpu ? "GPU attestation asserted" : null;
  const hardware: PrivacyLabel["label"]["hardware"] = fromCache
    ? { attested: false, tee: null, gpu_attested: false, verified_by: null, development_report: false, text: "No provider ran: this answer came from the response cache, so no hardware was involved." }
    : enclave
      ? {
          attested: true,
          tee,
          gpu_attested: gpu,
          verified_by: ua ? "gateway_receipt" : "router_attestation",
          development_report: false,
          text: ua
            ? `Attested hardware${teeBits ? ` (${teeBits})` : ""}. The router checked the gateway's signed receipt for this exchange: its signature, its key set and the hashes of the exchange, and that the upstream was verified inside a trusted execution environment. It does not show what the software there did with the prompt.`
            : `Attested hardware${tee ? ` (${tee})` : ""}. The router had verified this provider's hardware attestation report when it routed the request. That shows what the provider was running, not what its software did with the prompt.`,
        }
      : simulated
        ? { attested: false, tee: null, gpu_attested: false, verified_by: null, development_report: true, text: "Not hardware. This provider answered under a development report, which is not a hardware proof." }
        : ua && gatewayOk === false
          ? {
              attested: false,
              tee: null,
              gpu_attested: false,
              verified_by: null,
              development_report: false,
              text: `Not proven. The provider's signed receipt did not show an attested upstream.${reason ? ` Reason recorded: ${reason}.` : ""}${withheld ? " The router withheld the reply for that reason." : ""}`,
            }
          : {
              attested: false,
              tee: null,
              gpu_attested: false,
              verified_by: null,
              development_report: false,
              text: disclosure === null ? "Not shown. The receipt does not record whether this provider was running in attested hardware, so none is claimed." : "None shown. The router had no fresh hardware attestation for this provider when it answered.",
            };

  // ---- who read the prompt --------------------------------------------------------------------------------------
  const who = provider ? `the provider (${provider})` : "the provider";
  const named = who;
  let access: ProviderAccess;
  if (fromCache) access = "none";
  else if (enclave) access = "attested_enclave";
  else if (withheld === true || (ua && gatewayOk === false) || simulated) access = "unproven_provider";
  else if (disclosure === "policy") access = "documented_policy";
  else if (disclosure === "vendor-forwarded") access = "provider";
  else access = "unknown";
  const readersText = {
    none: "Only AnyRoute's router read this request, in memory. The answer came from the response cache, so no provider saw the request. The cached answer was produced earlier by a provider that read the earlier request.",
    attested_enclave: `AnyRoute's router read the prompt in memory to route it. It then went to ${named}, whose hardware attestation the router had verified. The software in that enclave reads it there.`,
    unproven_provider: `AnyRoute's router read the prompt in memory to route it. It then went to ${named}, which read it and produced a reply, but the receipt does not show an attested enclave.${reason ? ` Reason recorded: ${reason}.` : ""}${withheld === true ? " The router withheld the reply from the caller; the provider had already generated it." : ""}`,
    documented_policy: `AnyRoute's router read the prompt in memory to route it. It then went to ${named}, which documents a no-retention policy. That policy is a statement by the provider; hardware does not prove it.`,
    provider: `AnyRoute's router read the prompt in memory to route it. It then went to ${named}, which may keep or log it under its own terms.`,
    unknown: `AnyRoute's router read the prompt in memory to route it. It then went to ${named}. The receipt does not record how that provider handles prompts.`,
  }[access];
  const byokNote = mode === "byok" ? ` The call used your own key with ${who}, so ${who} can tie it to your account with them.` : "";

  // ---- network --------------------------------------------------------------------------------------------------
  const transports = opts.unlinkableTransports;
  const via: "tor" | "relay" | "tor_or_relay" | null =
    lane !== "unlinkable" ? null : transports && transports.length ? (transports.includes("onion") && transports.includes("ohttp") ? "tor_or_relay" : transports.includes("onion") ? "tor" : "relay") : "tor_or_relay";
  const keyed = mode === "prepaid" || mode === "paywith" || mode === "byok";
  const counterless = keyed;
  const counter: "none" | "about_a_minute" | "possible" = lane === "unlinkable" ? "none" : counterless ? "none" : mode === "per_call" || mode === "blind" ? "about_a_minute" : "possible";
  const wasOn = via === "tor" ? "over Tor" : via === "relay" ? "through an independent relay" : "over Tor or through an independent relay";
  const network: PrivacyLabel["label"]["network"] =
    lane === "unlinkable"
      ? {
          hidden: true,
          via,
          stored: false,
          counter,
          text: `AnyRoute did not see your network address. This lane is only served to requests that arrive ${wasOn}; anything that arrives directly is refused before it is served. AnyRoute's servers see the onion proxy or the relay, not you, so no per-address counter is kept for the request. The model provider sees AnyRoute, not you.`,
        }
      : {
          hidden: false,
          via: null,
          stored: false,
          counter,
          text:
            `AnyRoute's servers saw the network address your request arrived from (yours, or your VPN's or proxy's). AnyRoute's software does not write it to the generation record, the receipt or any other table. ` +
            (counter === "none"
              ? "This call carried an API key, and calls with a key are rate-limited per key, so the address was not used as a counter key either. "
              : counter === "about_a_minute"
                ? "This call carried no API key, so the address was used as the key of a rate-limit counter that expires about a minute later (in Redis, or in process memory when Redis is not used). "
                : "If this call carried no API key, the address was used as the key of a rate-limit counter that expires about a minute later; the receipt does not record which it was. ") +
            (lane === null ? "The receipt does not record a lane, so the label assumes the address was visible. " : "") +
            "The model provider sees AnyRoute's servers, not you: no header of yours and not your address is forwarded. The network provider that hosts AnyRoute sits in front of it, and what that provider logs is outside what a receipt can show.",
        };

  // ---- payment --------------------------------------------------------------------------------------------------
  const payer = str(p.payer);
  const tx = str(p.payment_tx);
  const nullifier = str(p.nullifier);
  let payment: PrivacyLabel["label"]["payment"];
  if (mode === "blind" || (!mode && nullifier)) {
    payment = { kind: "blind_token", identifies: "spent_token", text: "Paid with a blind token. The receipt names no account, key or wallet, only the hash of the spent token. The router signed the token blind, so the token itself cannot be used to match this spend to the purchase; the timing and size of purchases and spends can still hint at a link, most of all when few tokens are in use." };
  } else if (mode === "paywith") {
    payment = { kind: "pay_with_stock_token", identifies: "api_key", text: "Paid through Stock Token pay-with, charged against an API key. The receipt names the key by its hash and records the token used." };
  } else if (mode === "byok") {
    payment = { kind: "own_provider_key", identifies: "api_key", text: "The provider was paid with your own provider key; AnyRoute's fee was charged to an API key's balance. The receipt names that key by its hash." };
  } else if (mode === "prepaid") {
    payment = { kind: "key_balance", identifies: "api_key", text: "Paid from the balance of an API key. The receipt names the key by its hash." };
  } else if (mode === "per_call" && tx) {
    payment = { kind: "x402", identifies: "wallet", text: "Paid per call by an on-chain payment from a wallet (x402). The receipt names the wallet address and the payment transaction, which are public on the chain." };
  } else if (mode === "per_call") {
    payment = { kind: "wallet_balance", identifies: "wallet", text: "Paid per call from a wallet's account balance, authorised by that wallet's signature. The receipt names the wallet address." };
  } else if (fromCache) {
    payment = {
      kind: "cache_hit",
      identifies: payer ? (KEY_HASH.test(payer) ? "api_key" : "wallet") : null,
      text: `No charge: this answer came from the response cache.${payer ? ` The receipt names the ${KEY_HASH.test(payer) ? "API key, by its hash," : "wallet"} that asked.` : ""}`,
    };
  } else {
    payment = { kind: "unknown", identifies: null, text: "The receipt does not record how this call was paid." };
  }

  // ---- what was kept --------------------------------------------------------------------------------------------
  const linked: "api_key" | "wallet" | "nobody" | "unknown" =
    payment.identifies === "api_key" ? "api_key" : payment.identifies === "wallet" ? "wallet" : payment.identifies === "spent_token" ? "nobody" : "unknown";
  const cacheState: "never" | "only_if_requested" | "cache_hit" = fromCache ? "cache_hit" : lane === "attested" || lane === "unlinkable" || mode === "blind" ? "never" : "only_if_requested";
  const identityRecord =
    linked === "api_key" ? "the hash of the API key that paid" : linked === "wallet" ? "the wallet address that paid" : linked === "nobody" ? "the hash of the spent token, and no account" : "who paid (an API key hash or a wallet address; for a blind token, nobody)";
  const records = [
    "the model and provider that answered",
    "token counts and the cost",
    "timing, whether the reply streamed, and how it ended",
    "SHA-256 fingerprints of the request and of the reply, not their text",
    identityRecord,
    "which providers were tried and how each attempt ended, including up to 200 sanitized characters of a failed provider's error, which could quote request text",
    "a ledger line for the charge",
    ...(lane === "unlinkable" ? [] : ["the app name and address the request sent in HTTP-Referer or X-Title, if it sent one"]),
  ];
  const BATCH_SENTENCE =
    "This call was a line of a batch. Its prompt and reply were kept encrypted in Redis or the router's memory (never in the database). The prompt was deleted when the batch finished; the reply when its results expired: 24 hours after it finished, unless the operator set another time.";
  const cacheSentence =
    cacheState === "never"
      ? "This call was not eligible for the response cache, so no response-cache copy of the reply was kept."
      : cacheState === "cache_hit"
        ? "This answer was served from the response cache, which holds an encrypted copy of the earlier reply in memory or Redis until it expires; it does not cache the prompt itself. Semantic caching also keeps a hashed word vector of the prompt in memory."
        : "The response cache is opt-in. If the request asked for it, an encrypted copy of the reply stayed in memory or Redis until it expired (the prompt itself is not cached; the semantic cache keeps only a hashed word vector of it, in memory); the receipt does not record whether it did.";
  const stored: PrivacyLabel["label"]["stored"] = {
    prompt_text: false,
    reply_text: false,
    client_address: false,
    fingerprints: true,
    linked_to: linked,
    cache: cacheState,
    records,
    public_by_id: true,
    text: `AnyRoute's database kept a record of this call: ${records.join("; ")}. It has no column for the prompt, the reply or your network address. ${batch ? BATCH_SENTENCE : cacheSentence} Unexpected library errors can also quote content fragments in logs. The signed receipt is readable by anyone who has its id.`,
  };

  // ---- summary --------------------------------------------------------------------------------------------------
  const readLine = {
    none: "Read by: AnyRoute's router only. The answer came from the response cache, so no provider saw this request.",
    attested_enclave: `Read by: AnyRoute's router (in memory, to route it) and the provider's attested enclave${provider ? ` (${provider})` : ""}.`,
    unproven_provider: `Read by: AnyRoute's router and ${named}, which could not be shown to be an enclave${withheld === true ? ", so the reply was withheld" : ""}.`,
    documented_policy: `Read by: AnyRoute's router (in memory, to route it) and ${named}, which documents a no-retention policy that hardware does not prove.`,
    provider: `Read by: AnyRoute's router (in memory, to route it) and ${named}, which may keep it under its own terms.`,
    unknown: `Read by: AnyRoute's router (in memory, to route it) and ${named}; the receipt does not say how that provider handles prompts.`,
  }[access] + (mode === "byok" ? ` Your own provider key was used.` : "");
  const netLine =
    lane === "unlinkable"
      ? `Your IP address: hidden from AnyRoute. This lane only takes requests that arrive ${wasOn}.`
      : counter === "none"
        ? "Your IP address: seen by AnyRoute's servers when you connected; not saved with this answer."
        : counter === "about_a_minute"
          ? "Your IP address: seen by AnyRoute's servers; held in a rate-limit counter for about a minute, not saved with this answer."
          : "Your IP address: seen by AnyRoute's servers; not saved with this answer (a rate-limit counter may hold it for about a minute).";
  const payLine = {
    blind_token: "Paid with: a blind token. The receipt names no account, key or wallet.",
    pay_with_stock_token: "Paid with: Stock Token pay-with, charged against an API key. The receipt names the key by its hash.",
    own_provider_key: "Paid with: your own provider key, plus a fee on an API key's balance. The receipt names that key by its hash.",
    key_balance: "Paid with: an API key's balance. The receipt names the key by its hash.",
    x402: "Paid with: an on-chain payment from a wallet (x402). The receipt names the wallet and the transaction.",
    wallet_balance: "Paid with: a wallet's account balance. The receipt names the wallet address.",
    cache_hit: "Paid with: nothing. A cached answer is free.",
    unknown: "Paid with: not recorded in this receipt.",
  }[payment.kind];
  const keptLine = batch
    ? "Kept: counts, cost, timing and hashes. Batch content stays sealed outside the database; prompts are deleted when the batch finishes, replies when results expire."
    : cacheState === "never"
      ? "Kept: token counts, cost, timing and hashes of the request and reply. No response-cache copy. Provider errors can quote request fragments."
      : cacheState === "cache_hit"
        ? "Kept: token counts, cost, timing and hashes. The response cache holds an encrypted copy of the earlier reply, not the prompt, until it expires."
        : "Kept: token counts, cost, timing and hashes of the request and reply. Only the reply is cached on request; provider errors can quote request fragments.";
  const hwLine = fromCache
    ? "Hardware: none involved; no provider ran."
    : enclave
      ? `Hardware: attested${teeBits ? ` (${teeBits})` : ""}${ua ? ", checked from the gateway's signed receipt" : ", checked by the router before it routed the request"}.`
      : simulated
        ? "Hardware: a development report only, not real hardware."
        : ua && gatewayOk === false
          ? `Hardware: not proven.${reason ? ` Reason recorded: ${reason}.` : ""}`
          : disclosure === null
            ? "Hardware: not recorded in this receipt, so none is claimed."
            : "Hardware: none shown. The router had no fresh attestation for this provider.";
  const summary = [readLine, netLine, payLine, keptLine, hwLine];

  const base = plain(opts.baseUrl, 300) ?? plain(p.router, 300);
  const verifyUrl = id && base && /^https?:\/\//i.test(base) ? `${base.replace(/\/+$/, "")}/verify?r=${encodeURIComponent(id)}` : null;

  const out: PrivacyLabel = {
    receipt_id: id,
    lane,
    label: {
      output,
      prompt_readers: { router: true, provider: { id: provider, access, reply_withheld: access === "none" ? false : withheld }, text: readersText + byokNote },
      network,
      payment,
      stored,
      hardware,
    },
    summary,
    short: "",
    verify_url: verifyUrl,
  };
  if (output.kind !== "text") {
    const providerNote = provider
      ? output.kind === "unknown" ? ` The provider named in the receipt is ${provider}.` : ` The request went to the provider (${provider}) named in the receipt; its retention policy is not established by the unit type.`
      : " No provider is named in this receipt.";
    const search = output.kind === "call" && (p.operation === "search" || p.modality === "search");
    out.label.prompt_readers.text = `AnyRoute's router handles request text in memory to route it. ${output.text}${providerNote}` +
      (search && provider ? ` The query text was sent to the search provider (${provider}) named in the receipt.` : "");
    const hashes = CONTENT_HASH.test(str(p.request_sha256) ?? "") && CONTENT_HASH.test(str(p.response_sha256) ?? "");
    const records = [
      ...(provider ? ["the provider id"] : []),
      ...(str(p.model) ? ["the model id"] : []),
      ...(obj(p.usage) ? [`usage in ${output.unit_type}${output.units === null ? " (quantity not recorded)" : ` (${output.units})`}`] : []),
      ...(p.cost !== undefined ? ["the recorded cost"] : []),
      ...(hashes ? ["hashes of the request and output"] : []),
    ];
    const content = output.kind === "image" ? "image" : output.kind === "audio" ? "audio" : output.kind === "video" ? "video" : null;
    out.label.stored.records = records;
    out.label.stored.fingerprints = hashes;
    out.label.stored.cache = "not_recorded";
    out.label.stored.prompt_text = null;
    out.label.stored.reply_text = null;
    out.label.stored.text = `The receipt records ${records.join("; ") || "no recognized usage, provider or output-hash fields"}. ` +
      (content && hashes ? `The generation database keeps these hashes, not the ${content} itself. ` : "") +
      "The unit type does not establish retention of content, references or artifacts outside that record, including by the provider." +
      (batch ? ` ${BATCH_SENTENCE}` : "");
    out.summary[0] = `Read by: AnyRoute's router in memory${provider ? `; provider named: ${provider}` : "; provider not recorded"}. ${OUTPUT_NAMES[output.kind]} metering.`;
    out.summary[3] = `Kept in the receipt: ${hashes ? "request and output hashes" : "hashes not recorded"}${output.units === null ? "" : `; ${output.units} ${output.unit_type}`}. Content retention is not established by metering.${batch ? " Batch content is kept sealed until results expire." : ""}`;
    out.label.hardware.text = out.label.hardware.text.replace(/prompt/g, "request content");
    if (output.kind === "unknown") {
      out.label.stored.client_address = null;
      out.label.network = { hidden: false, via: null, stored: null, counter: "possible", text: "The receipt does not establish network-address handling for this unfamiliar output type." };
      out.summary[1] = out.label.network.text;
    }
  }
  // Council receipts name several readers: members get the request, and the judge gets their answers too.
  const council = obj(p.council);
  if (council && Array.isArray(council.members)) {
    const members = council.members;
    const ids = [...members.map((m) => obj(m)?.provider), obj(council.judge)?.provider]
      .filter((v): v is string => typeof v === "string" && PROVIDER_ID.test(v));
    out.label.prompt_readers.participants = [...new Set(ids)];
    const note = ` Council members handled the request; the judge handled the request and member answers. Providers named in this receipt: ${[...new Set(ids)].join(", ") || "not recorded"}.`;
    out.label.prompt_readers.text += note;
    out.summary[0] = "Read by: AnyRoute's router in memory, council member providers and the judge (including member answers). See the individual receipts for each provider's handling.";
  }
  out.short = shortLine(out);
  return out;
}

const readShort = (l: PrivacyLabel): string => {
  const pr = l.label.prompt_readers.provider;
  if (l.label.prompt_readers.participants) return "router + council members + judge";
  if (l.label.output?.kind === "unknown") return pr.id ? "router; provider named" : "router; provider not recorded";
  switch (pr.access) {
    case "none":
      return "router only (cache)";
    case "attested_enclave":
      return "router + proven enclave";
    case "unproven_provider":
      return pr.reply_withheld === true ? "router + unproven provider (reply withheld)" : "router + unproven provider";
    case "documented_policy":
      return "router + provider (policy, unproven)";
    default:
      return "router + provider";
  }
};
const netShort = (l: PrivacyLabel): string => {
  const n = l.label.network;
  if (n.stored === null) return "handling not recorded";
  if (n.hidden) return `hidden (${n.via === "tor" ? "Tor" : n.via === "relay" ? "relay" : "Tor or relay"})`;
  return n.counter === "about_a_minute" ? "seen, held ~1 min for rate limits" : n.counter === "possible" ? "seen, may be held ~1 min for rate limits" : "seen, not saved";
};
const payShort = (l: PrivacyLabel): string =>
  ({ blind_token: "blind token, no account", pay_with_stock_token: "Stock Token via API key", own_provider_key: "own provider key", key_balance: "API key balance", x402: "wallet, x402", wallet_balance: "wallet balance", cache_hit: "nothing (cache)", unknown: "not recorded" })[l.label.payment.kind];

/**
 * The label in one line for a chat message: who read the prompt, who saw the address, how it was paid.
 * `via: "telegram"` is for an answer relayed through Telegram: Telegram carries the message and the sender's
 * address, and the bot reaches the router from the server side, so the router never sees that address.
 */
export function shortLine(l: PrivacyLabel, via?: "telegram"): string {
  const prefix = l.label.output && l.label.output.kind !== "text" ? `${OUTPUT_NAMES[l.label.output.kind]} · ` : "";
  if (via === "telegram") return `${prefix}Read by: Telegram + ${readShort(l)} · IP: seen by Telegram, not AnyRoute · Paid: ${payShort(l)}`;
  return `${prefix}Read by: ${readShort(l)} · IP: ${netShort(l)} · Paid: ${payShort(l)}`;
}

// ==== shared with packages/client/src/privacy.ts (end) ====

// ---- fetching the router's label ---------------------------------------------------------------------------------------

export const privacyPath = (receiptId: string): string => `/api/v1/receipts/${encodeURIComponent(receiptId)}/privacy`;

/**
 * The label the router computes for a receipt id: GET /api/v1/receipts/{id}/privacy, public by id like the receipt.
 * It is the router's reading of the receipt; to check it, verify the receipt and compare with `privacyLabel(receipt)`.
 */
export async function fetchPrivacyLabel(baseUrl: string, receiptId: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<PrivacyLabel> {
  const res = await fetchImpl(baseUrl.replace(/\/$/, "") + privacyPath(receiptId), { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${privacyPath(receiptId)} failed with ${res.status}`);
  const json = (await res.json()) as { data?: unknown } | null;
  const label = (json && typeof json === "object" && "data" in json ? json.data : json) as Partial<PrivacyLabel> | null;
  if (!label || typeof label !== "object" || !label.label || !Array.isArray(label.summary)) throw new Error("the router's privacy label is malformed");
  return label as PrivacyLabel;
}
