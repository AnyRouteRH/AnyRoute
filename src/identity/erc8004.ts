import { encodeFunctionData, keccak256, parseAbi, toHex, type Hex } from "viem";
import { canonicalJson } from "../lib/util.ts";

// ERC-8004 encodings used by the router: the identity registry's register() and Registered event,
// the reputation registry's giveFeedback(), and the validation registry's request and response. The router only
// prepares calldata and reads receipts; it never sends a transaction except the opt-in registrar job.

export const identityRegistryAbi = parseAbi([
  "function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)",
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
export const reputationRegistryAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
export const validationRegistryAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
]);

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const TRACK_RECORD_TAG = "anyroute-track-record";
/** On-chain metadata key carrying the URL of the router's receipt key set. */
export const RECEIPT_KEYS_METADATA = "anyroute.receiptKeys";

export const agentRegistryId = (chainId: number, registry: string) => `eip155:${chainId}:${registry.toLowerCase()}`;
/** keccak256 of the canonical JSON of a document: the hash an ERC-8004 entry commits to. */
export const documentHash = (doc: unknown): Hex => keccak256(toHex(canonicalJson(doc)));

export function registerCall(agentURI: string, receiptKeysUrl: string): Hex {
  return encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [agentURI, [{ metadataKey: RECEIPT_KEYS_METADATA, metadataValue: toHex(receiptKeysUrl) }]] });
}

export function giveFeedbackCall(i: { agentId: bigint; score: number; tag1: string; tag2: string; feedbackURI: string; feedbackHash: Hex }): Hex {
  return encodeFunctionData({ abi: reputationRegistryAbi, functionName: "giveFeedback", args: [i.agentId, BigInt(i.score), 0, i.tag1, i.tag2, "", i.feedbackURI, i.feedbackHash] });
}

export function validationRequestCall(i: { validator: Hex; agentId: bigint; requestURI: string; requestHash: Hex }): Hex {
  return encodeFunctionData({ abi: validationRegistryAbi, functionName: "validationRequest", args: [i.validator, i.agentId, i.requestURI, i.requestHash] });
}

export function validationResponseCall(i: { requestHash: Hex; response: number; responseURI: string; responseHash: Hex; tag: string }): Hex {
  return encodeFunctionData({ abi: validationRegistryAbi, functionName: "validationResponse", args: [i.requestHash, i.response, i.responseURI, i.responseHash, i.tag] });
}
