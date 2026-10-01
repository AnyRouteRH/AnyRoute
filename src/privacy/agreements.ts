import type { ExternalDoc } from "./types.ts";

export const agreementContractStores: ExternalDoc["otherStores"] = [{
  id: "agreement-contracts",
  name: "Agreement escrow and dispute records on chain",
  purpose: "The agreement contracts are not switched on yet. If deployed and used, a payer funds individual milestones in USDG and an oracle can pay only that agreement's payer or payee. The optional agreements service indexes this public state, stores party evidence and model verdict statements, and prepares payer-signed funding transactions; its separate database and reader disclosures appear in this inventory.",
  holds: "Public permanent blockchain state, transaction calldata and events: payer, payee, token, escrow, oracle, owner, panel and jury wallet addresses; agreement and milestone ids; amounts, deadline, immutable review window and dispute timeout, delivery and dispute-opening timestamps and status; terms and deliverable digests, opening evidence digest and evidence root; jury version, signer order, threshold, participation and consensus bitmaps, signed per-signer basis-point verdicts, tally digest, final verdict, neutral stale-dispute 50/50 recovery events and payouts; a panel-pending tally remains historical metadata after escrow recovery. The digest fields accept arbitrary caller-supplied bytes32 values; they do not prove the absence of encoded text or conceal low-entropy content. Evidence text is not required by the contracts, and any off-chain jury service needs its own retention disclosure. Deployment prints only escrow and oracle addresses.",
  ttl: "Permanent public chain history; the contracts have no deletion function. When enabled, the agreement service indexes chain records into the separately described agreement tables.",
  requestText: "hashes",
  evidence: [
    { file: "contracts/src/agents/AgreementEscrow.sol", contains: "mapping(uint256 => Agreement) public agreements" },
    { file: "contracts/src/agents/AgreementEscrow.sol", contains: "event DisputeOpened" },
    { file: "contracts/src/agents/AgreementEscrow.sol", contains: "uint256 disputedAt" },
    { file: "contracts/src/agents/AgreementEscrow.sol", contains: "event StaleDisputeResolved" },
    { file: "contracts/src/agents/DisputeOracle.sol", contains: "struct Vote" },
    { file: "contracts/src/agents/DisputeOracle.sol", contains: "event TallyRecorded" },
    { file: "contracts/script/DeployAgreements.s.sol", contains: "console2.log" },
  ],
}];
