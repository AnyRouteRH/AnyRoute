import type { ProviderVerification } from "./attestation.js";
import { hexToBytes } from "./bytes.js";
import { AnyRouteError } from "./errors.js";
import type { Fetch } from "./types.js";

// End-to-end encryption to a verified enclave. The cryptography is a plug-in: implement {@link HpkeHook} with whatever
// HPKE (RFC 9180) library and wire format the provider's sidecar speaks. The client's part is the policy around it:
//
//   * it seals only to a key the provider's quote commits to (`bindings.hpke_pubkey`), and only after verification passed;
//   * it sends the sealed bytes with the media type below and asks the hook to open the reply.

export const HPKE_MEDIA_TYPE = "application/anyroute-hpke";

export type HpkeExchange = {
  /** Bytes to send as the request body. */
  body: Uint8Array;
  /** Extra request headers (for example a key or context identifier). The client adds the content type. */
  headers?: Record<string, string>;
  /** Opens the response body. Holds whatever per-request secret the scheme needs. */
  open(response: { body: Uint8Array; headers: Headers }): Promise<Uint8Array>;
};

export interface HpkeHook {
  /** Seal `plaintext` to `recipientPublicKey`. */
  seal(input: { plaintext: Uint8Array; recipientPublicKey: Uint8Array; url: string }): Promise<HpkeExchange>;
}

export type SealedPostOptions = {
  hook: HpkeHook;
  /** Where to send the sealed request: the provider's endpoint, not a router path that could not read it. */
  url: string;
  /** The result of a verification that passed. Its `bound.hpkePubkey` is the only key used unless `unboundRecipientKey` is set. */
  verification: ProviderVerification;
  json: unknown;
  headers?: Record<string, string>;
  fetch?: Fetch;
  signal?: AbortSignal;
  /** A recipient key that is NOT committed in the quote. The request is then encrypted but not bound to the attested enclave. */
  unboundRecipientKey?: string;
};

/** POST an HPKE-sealed JSON request and return the opened JSON reply, with the raw HTTP status. */
export async function sealedPost(o: SealedPostOptions): Promise<{ status: number; json: unknown }> {
  if (!o.verification.ok) throw new AnyRouteError("Refusing to encrypt to a provider that did not verify.", "attestation_refused");
  const keyHex = o.verification.bound?.hpkePubkey ?? o.unboundRecipientKey ?? null;
  if (!keyHex) throw new AnyRouteError("The provider's quote does not commit to an HPKE public key, so a request cannot be sealed to the attested enclave.", "hpke_key_not_bound");
  const plaintext = new TextEncoder().encode(JSON.stringify(o.json));
  const ex = await o.hook.seal({ plaintext, recipientPublicKey: hexToBytes(keyHex), url: o.url });
  const res = await (o.fetch ?? fetch)(o.url, {
    method: "POST",
    signal: o.signal,
    headers: { ...o.headers, ...ex.headers, "content-type": HPKE_MEDIA_TYPE, accept: HPKE_MEDIA_TYPE },
    body: ex.body as unknown as BodyInit,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith(HPKE_MEDIA_TYPE)) {
    // An error the server produced before it could open the request is plain JSON.
    let json: unknown = null;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  }
  const opened = await ex.open({ body: bytes, headers: res.headers });
  return { status: res.status, json: JSON.parse(new TextDecoder().decode(opened)) };
}
