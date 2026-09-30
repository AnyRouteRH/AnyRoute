// @anyroute/sdk: the official TypeScript SDK. A typed façade over @anyroute/client, which keeps every piece of
// cryptography (receipt v1 and v2 checks, the chunk chain, attestation, blind tokens, the transparency log).

export { Anyroute, DEFAULT_BASE_URL, parseJsonl } from "./client.js";
export type { AnyrouteOptions, CallOptions, ChatOptions, ChatResponse, ReceiptCheck, ReceiptProof, WithMeta } from "./client.js";
export { AnyrouteAPIError, AuthenticationError, BadRequestError, BatchTimeoutError, NotFoundError, RateLimitError, parseRetryAfter } from "./errors.js";
export { DISCLOSURES, LANES, isDisclosure, isLane, routingHeaders, stricterLane, supportsLane, withRouting } from "./lanes.js";
export type { DisclosureMax, Lane, RoutingOptions } from "./lanes.js";
export { TERMINAL_BATCH_STATUSES } from "./types.js";
export type {
  Batch,
  BatchEndpoint,
  BatchList,
  BatchRequestLine,
  BatchResultLine,
  BatchStatus,
  CreateBatchParams,
  EmbeddingsRequest,
  EmbeddingsResponse,
  Model,
  Preset,
  PresetDoc,
  PresetVersion,
  ProviderPrefs,
  Receipt,
  RerankRequest,
  RerankResponse,
  RerankResult,
  ResponseMeta,
} from "./types.js";

// Receipt and chain primitives, re-exported so one import covers offline verification.
export {
  AnyRouteError,
  AttestationRefused,
  ChatStream,
  ReceiptInvalid,
  checkChain,
  chunkChain,
  decodeReceiptV2,
  fetchReceiptKeys,
  receiptLeaf,
  receiptLeafV2,
  verifyMerkleProof,
  verifyReceipt,
  verifyReceiptV2,
} from "@anyroute/client";
export type { AnyRouteMeta, ChatBody, ChatResult, Check, KeySet, ReceiptEnvelope, ReceiptV2Verification, ReceiptVerification } from "@anyroute/client";
