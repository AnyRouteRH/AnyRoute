# AnyRoute Whitepaper

## 1. Abstract

AnyRoute combines a shared inference API, USDG accounting, privacy lanes, signed receipts and agent controls. Each request carries evidence and limits: the router selects an eligible endpoint, accounts for the call and records what happened. A requested privacy floor causes refusal if no endpoint qualifies.

The hosted service has SEAL attested serving, key transparency anchored in Sigstore Rekor, per-host receipt anchoring, Tor onion access with blind tokens, encrypted chat, private files and a data inventory. The network is open for approved Intel TDX hosts, with fresh evidence, signed policy and sanctions screening. Agent rulebooks, approvals on /agents and Telegram, ledgers, alerts, circuit breakers, progressive autonomy, certificates, public profiles and network statistics are switched on. Sealed hosting is available, but no sealed agent is registered at anyroute.tech yet.

On ordinary paths the router reads request text in memory; correctly client-encrypted chat forwards ciphertext instead. Network host payouts, the planned 5% network-fee purchase and burn of $ANYR, and host-bond slashing are not switched on yet. Agreements between agents are live, with their escrow and dispute contracts deployed; automatic jury rulings are switched on. Next are agent wallets with on-chain rules, GPU hosts on the network and network payouts. This paper separates those states from existing behavior, explains the trust required by each path and gives references for independent inspection. It describes software and protocol mechanics, not an offer or investment advice.

## 2. The problem

### 2.1 A request crosses several boundaries

An AI request can combine sensitive instructions, identifying information and a payment relationship in one exchange. A prompt might contain a document excerpt, source code, an account number or an instruction about a person's work. The connection exposes network information to whoever receives it. An API key or wallet identifies the account that pays. The provider needs enough input to compute an answer, but that necessity does not require every intermediary to receive the same information.

Transport encryption protects a connection against observers between its endpoints. It does not prevent the endpoint that terminates that connection from reading the body. Likewise, a promise not to retain data is a statement about handling after access; it is not a cryptographic barrier to access. A useful architecture must distinguish transmission, processing, persistence and attribution. Collapsing those questions into a single word such as privacy prevents a user from choosing the appropriate path.

### 2.2 An agent needs a spending boundary

Giving an agent a funded credential grants authority to make requests. A budget in instructions alone depends on the agent following those instructions, interpreting amounts correctly and maintaining its own state. Parallel calls, retries, a wrong model selection or a long generation can make that boundary difficult to reason about. A useful control must be checked by the service that admits and accounts for the work.

The AnyRoute rulebook therefore attaches constraints to a key and evaluates them at the router. It can restrict models, lanes, declared tools, working hours, output size and spending over several intervals. The owner can require approval or stop the next request. This is a boundary for activity through AnyRoute. It does not control unrelated credentials, other services, the agent's operating system or a tool implementation running elsewhere.

### 2.3 Capacity needs a common admission rule

Inference capacity comes from hosts with different hardware, software, latency, availability and operating practices. Adding another endpoint to a catalog does not make those differences disappear. A host claiming to run an approved image needs to present evidence, and a router needs a repeatable decision about whether to send it traffic. A bond alone cannot establish that the right workload is running.

The network connects host admission to a published policy and verified quote bindings. Its current approved recipe is narrow: Intel TDX with the specified sidecar, inference engine and Qwen2.5 0.5B model. A general installation is not automatically admitted. Probation and observed service quality influence routing weight after admission. This creates a concrete route for additional operators while preserving a common acceptance boundary; it does not establish independent governance of the router or unrestricted admission of arbitrary capacity.

## 3. The router

### 3.1 One interface, explicit routing constraints

The Bun and Hono router exposes chat, embeddings and related adapters through a shared HTTP API. A request names a model and may constrain provider selection, disclosure and lane. Catalog entries describe available endpoints and their terms. Adapters reuse the router's request paths so that routing, billing and receipt behavior follow the same controls rather than establish separate accounting systems.

The core request flow can be read as an admission and evidence pipeline:

```text
Client request
     |
     v
Authenticate and interpret routing constraints
     |
     v
Apply applicable key and agent rules
     |
     v
Reserve spending capacity -> select an eligible endpoint
     |                              |
     |                         refuse if none
     v
Serve request -> settle recorded usage -> sign receipt
                                          |
                                          v
                              receipt proof and later anchor
```

The diagram is a conceptual flow, not a promise that every endpoint executes identical operations in identical order. For example, encrypted chat has a bounded ciphertext envelope and a fixed gateway path, while retrieval makes several underlying calls. The common requirement is that an adapter preserve the restrictions and evidence of the calls it uses.

### 3.2 Lanes and disclosures

The three lane names represent routing floors, not interchangeable confidentiality claims.

| Lane | Admission requirement | Router's view on ordinary chat | Payment and network boundary |
| --- | --- | --- | --- |
| `public` | Eligible endpoint under ordinary routing and disclosure constraints | Request text and routing metadata | Depends on the chosen authentication and payment path |
| `attested` | Fresh accepted attestation for the serving endpoint | Request text and routing metadata | A key or payment relationship can remain visible |
| `unlinkable` | Attested eligibility, blind-token payment and an accepted identity-separating ingress | Request text, size and timing | Hosted Tor onion path separates address; token blinding separates purchase from use |

The separate encrypted-chat adapter changes the content boundary of the latter two lanes, as Section 5 explains. It is not the default encoding of ordinary chat.

Disclosure classes answer a related question about evidence for provider data handling. The router distinguishes attested evidence, a documented policy and vendor-forwarded handling. A policy declaration does not become hardware evidence because it is listed in the catalog. A caller can set a disclosure ceiling; when both headers and request fields constrain selection, the stricter requirement applies. The attested and unlinkable lanes require the stricter attested selection boundary.

The router refuses a request when that boundary cannot be met. It does not silently move an attested request to public serving. An ordinary direct request asking for unlinkable service is refused when it lacks the required ingress and token. Clients should handle those refusals explicitly. A fallback chosen by the application is a new application decision, not evidence that the original requirement was satisfied.

### 3.3 Receipts and response labels

Responses carry `X-Receipt-Id` and lane and disclosure information; a policy hash is provided only when accepted attestation supports it. Streaming headers precede the answer, so the code uses conservative rules when several reachable endpoints might serve a stream. A client must inspect the final receipt rather than infer more from an early header than that header establishes.

Generation records include identifiers, model and provider, token counts, cost, timing and signed receipt data. They contain request and response hashes rather than prompt or answer text. This describes those records, not every temporary store in the application. A signature establishes that a particular key signed particular bytes. It does not independently establish semantic correctness, complete confidentiality or that every reported observation was accurate.

The receipt system includes JSON receipts and versioned CBOR/COSE receipt support. Verification checks the relevant encoding, signature, key and claims. Later Merkle anchoring supplies evidence of inclusion. A receipt may exist before its anchor is confirmed, and clients should distinguish a valid signature from a confirmed chain anchor. Attestation fields are evidence-bearing fields: missing or unchecked claims must not be treated as verified measurements.

### 3.4 USDG accounting and payment paths

Inference accounting uses a common USDG settlement unit while allowing several payment paths in the repository. Prepaid calls draw on a ledger balance. Wallet and contract paths have their own authorization and settlement requirements. Escrow deposits credit inference balances after finality and conversion checks. Blind-token calls draw from the shared token pool without attaching an ordinary user account to redemption.

The x402 path is switched on for chat and embeddings. A payment-required response describes the required authorization; the caller supplies a signed USDG transfer authorization, and the router validates and relays it before serving under the applicable constraints. An account-free payment flow still carries payment evidence. It is not the blind-token path and should not be described as separating the payer from the call.

## 4. SEAL: verifiable privacy

### 4.1 Evidence before eligibility

SEAL combines attested serving, encrypted transport paths, blind credits and a ledger of receipts, with measured policy where supported. The sidecar sits in front of a compatible model server inside a confidential VM. It measures configured model files, checks allow-lists, generates keys and obtains hardware evidence committing to its bindings. The router's attestor verifies evidence through configured verifiers and uses the accepted result in endpoint eligibility.

For Intel TDX, the protocol describes a hardware quote with measured registers and a report-data commitment. A fresh nonce binds a quote response to a verifier's challenge. Reading measurements from JSON is insufficient: a verifier must establish the quote's validity and recompute the commitment to the supplied bindings. Evidence freshness also matters. An old accepted quote does not establish that an endpoint remains eligible indefinitely.

The sidecar generates its TLS and receipt keys in memory. Its attestation reference is the digest of the boot quote. The TLS certificate connects that reference to the bound public key; verification checks the quote and certificate relationship and pins the accepted TLS key. This is different from accepting a self-signed certificate merely because it establishes an encrypted connection. The router also needs to use the pinned transport when it sends subsequent requests.

### 4.2 Bindings v1 and the implemented v2 extension

Legacy sidecar bindings commit the TLS public key, receipt public key, image digest, compose hash and model digest. Optional classifier and HPKE fields are included when enabled. The implemented report-data formula is:

```text
report_data = SHA-256(canonical_json(bindings)) || nonce
              32 bytes                            32 bytes
```

The opt-in SHA-256 sidecar bindings v2 extend that object with a version, source archive hash, engine name and image digest, and model identifier and digest. They retain the same report-data formula. Version validation rejects incompatible extension members and incomplete or unknown formats. Network admission uses these additional source, engine and model bindings; valid legacy evidence alone does not supply the complete admission-policy input.

This implemented extension is distinct from the separate fuller SHA-512 design described as next in the attestation specification. That design includes GPU evidence in the CPU commitment and is not switched on yet. The shared name v2 is therefore insufficient to identify a guarantee: verifiers need the actual versioned format and derivation.

Hashing a source archive identifies exact archive bytes. It does not prove that the archive produced the running image, that the named engine is the process serving a request or that declared software obeys every data-handling statement. Those relationships require inspection of the measured deployment and its build process. Likewise, an image digest is evidence about an identified artifact, not a proof that the artifact has no vulnerabilities.

### 4.3 Measurements and key transparency

The repository includes measurement bundles, measurement-registry integration and an append-only key transparency log. Bundles describe pinned software and measured deployment information. Registry records provide references that can be checked against off-chain evidence; the registry itself does not verify a hardware quote. A consumer trusting a registry record must understand the role of the attestor that submitted it.

The transparency log records public keys and configurations, including receipt keys and attestation bindings. It exposes signed checkpoints, tiles and proof endpoints. Inclusion demonstrates that a particular leaf is in a tree of a particular size. Consistency proofs connect checkpoints so a client can detect an incompatible history instead of accepting every newly signed root independently.

The hosted key log is anchored in Sigstore Rekor. Public anchoring enables comparison against an external record. Witness cosignatures are an additional supported mechanism: witnesses check consistency from their previous accepted checkpoint before cosigning. A witness quorum can prevent an incompatible view from gathering the required signatures under the stated independence assumption. Rekor anchoring instead supplies an external publication trail; it does not prevent the log from signing a bad checkpoint before a client or monitor checks that trail.

Clients need independently obtained key pins. Downloading a public key from the same untrusted response as a signature proves only that the response is internally consistent. Verification policy must specify which keys, witnesses or public-log records establish identity. Transparency verification is opt-in in the client code, so using that code without configuring the relevant checks does not automatically enforce the full log policy.

### 4.4 Per-host receipt anchoring

The router can collect receipt leaves signed by an attested host and assemble a per-host Merkle root. The resulting record identifies the provider, attestation reference and bound host receipt key, together with the root and its anchor information. This preserves a distinction between the router's account of a call and the host's signed exchange evidence.

An inclusion proof establishes that a receipt leaf belongs under the published root. A quote-bound signing key ties the signature to accepted attestation evidence, subject to the verifier's trust and freshness policy. Anchoring does not reveal the prompt text, prove the answer's usefulness or convert a host's software assertion into independent execution evidence. A verifier should check the signature, quote binding and inclusion separately.

### 4.5 What is kept

The `/keep` inventory is generated from the schema and accompanying descriptions of storage outside the database. It includes tables, columns, Redis families, application logging and request-body and address readers. Repository checks require newly introduced storage and readers to be described. This creates a concrete review surface for persistence claims, with evidence pointing back to code.

The generation and receipt records store metadata and hashes rather than conversation text. Other paths have different lifetimes and stores. For example, batch request and answer material is held sealed outside the database until expiry, and optional response-cache behavior has its own inventory entry. A statement about receipt storage must not be widened into a statement that no request material ever exists in memory or temporary storage anywhere.

Network addresses can also appear in rate-limiting keys on paths that receive them. Retention and handling depend on the ingress and feature. The router does not receive the original client address on the accepted onion path, but ordinary direct access exposes an address to the server. The inventory is the reference for those distinctions. It documents the implementation; it is not a cryptographic guarantee that an operator can never change logging or observe process memory.

### 4.6 Honest hardware limits

Ordinary serving requires the router to read request text in memory. Attestation does not conceal that text from the router. It establishes evidence about the endpoint selected after routing. The provider workload must also process the relevant plaintext to compute a normal answer.

CPU and GPU evidence are separate in the current implemented bindings. GPU evidence is not bound into the CPU quote by the fuller planned commitment. A gateway receipt can carry an upstream GPU-attestation assertion, but the router's accepted gateway evidence is not independent verification of every downstream GPU measurement. A verifier must identify who checked which evidence and which channel connects those checks to the exchange.

Confidential hardware adds trust in its vendor, firmware, evidence services and the chosen acceptance policy. It does not eliminate application bugs, compromised clients, data deliberately included in an answer, timing observations or every side channel. These limits remain relevant even when signatures, quote bindings and log proofs all verify.

## 5. Privacy paths

### 5.1 Tor onion access with blind tokens

The hosted unlinkable lane uses the router's Tor onion ingress and blind payment tokens. Tor separates the user's network address from the onion service connection. The ingress authenticates its origin to the router through a configured secret; a public caller cannot establish onion origin merely by adding a header. The lane requires that accepted origin, an eligible attested endpoint and blind-token authorization.

Blind tokens separate purchase from use through blinded issuance. The issuer signs a blinded credential; after unblinding, the client presents a valid token for redemption. Redemption checks validity and spending state without carrying the ordinary purchasing account into the request. Token issuance and denomination policies remain visible, and purchase itself may have an identifiable payment relationship. Separation applies to the blinded credential, not to every possible behavioral inference.

An API key or wallet-authenticated ordinary call does not satisfy the unlinkable credential boundary. A missing token or wrong ingress produces refusal. Text on ordinary unlinkable chat is still readable by the router and serving provider. A person can also identify themselves inside that text. Blind issuance cannot remove an identity that the caller supplies in a prompt.

Timing, request sizes, token denominations and external observations can correlate activity. An observer with access to both sides of a Tor connection can attempt timing correlation. Reusing identifying content or a separate session can create additional links. The lane removes specific direct identifiers from the router's ordinary authorization and connection view; it does not prove that all requests are uncorrelatable.

### 5.2 Encrypted chat through the attested gateway

Encrypted chat is switched on through `POST /api/v1/e2ee/chat/completions`. The client encrypts content on its device after verifying gateway attestation according to a caller-supplied verification policy. The router validates a bounded envelope, checks authentication, freshness and eligibility, reserves spending capacity and forwards ciphertext. It does not decrypt correctly client-encrypted message content on this path.

```text
Client: plaintext + gateway verification
     |
     | encrypted message content; visible routing envelope
     v
AnyRoute router: admission, accounting, ciphertext forwarding
     |
     v
Attested gateway: decrypt and restore content
     |
     | separate confidential channel
     v
Serving workload: process content and produce answer
     |
     v
Gateway encrypts reply -> router forwards -> client verifies/decrypts
```

Encryption terminates at the gateway enclave. This is not encryption directly from the client to a GPU. The gateway and serving workload need access to restored content, and their evidence and transport relationships are part of the trust model. The client verifies the encrypted reply and gateway receipt; the client code does not silently fall back to plaintext when verification fails.

Streamed decrypted chunks remain provisional until the complete gateway receipt verifies. An interrupted stream does not establish a complete authenticated answer. Browser-delivered client code must also be trusted; recipient-key compromise is not covered by a forward-secrecy guarantee in this format. The router cannot reproduce the gateway's plaintext request hash; the client can check it, and hashes of low-entropy plaintext can permit guessing.

The router still sees the model, roles, message counts and sizes, timing, usage and authorization metadata. With an ordinary prepaid key it also has an account relationship. Tor with blind tokens can provide the accepted unlinkable path for this adapter, combining a content boundary with the separate network and payment boundaries. None of those mechanisms hides every observable property of an exchange.

The adapter deliberately supports a narrower surface than ordinary chat. It accepts supported prepaid keys without incompatible content-policy or routing settings, or blind tokens. It refuses unsupported authorization and payment combinations rather than inspect encrypted content or bypass those restrictions. Content filtering in router memory cannot operate on encrypted content; calling the encrypted endpoint does not preserve every plaintext feature.

The sidecar's direct `anyroute-hpke/v1` transport is a separate repository path. A client can use the sidecar's attestation-bound HPKE key in the direct protocol, but ordinary router chat does not forward that format. A direct sidecar connection has its own authentication, network exposure and accounting context. It must not be described as the hosted encrypted-chat adapter simply because both involve encryption.

### 5.3 Private files and retrieval

The files interface extracts supported document text in the browser, including PDF support, and submits text for retrieval. The retrieval adapter chunks documents, obtains embeddings, ranks chunks by cosine similarity in memory and asks the chat model using selected context. Its underlying embedding and chat calls go through the router with the caller's constraints and produce ordinary billing records and receipts.

Documents, chunks and vectors are held for the retrieval request and discarded when it finishes; the adapter does not create a persistent document or vector store. It does not use the response cache. Those properties explain the private-files label in terms of persistence. They do not establish that the router cannot read the uploaded text: it must parse, chunk and rank that text, and selected providers process their respective inputs.

A specified lane or disclosure ceiling applies to the underlying calls rather than just to the final answer. If no explicit preference is supplied, the adapter prefers attested service when both the embedding and chat models have eligible attested endpoints; otherwise it uses ordinary public routing and discloses the choice. A caller requiring attested processing should state that requirement rather than rely on an implicit preference.

| Path | Content visible to router? | Original address separated? | Purchase separated from call? | Important remaining boundary |
| --- | --- | --- | --- | --- |
| Ordinary public or attested chat | Yes, in memory | Not by the lane alone | Not by the lane alone | Provider handling and chosen credentials |
| Ordinary onion unlinkable chat | Yes, in memory | Through accepted Tor ingress | Through blind tokens | Timing and identifying prompt content |
| Encrypted chat with prepaid key | Correctly encrypted content is hidden | Not by encryption alone | No, key identifies account relationship | Gateway plaintext and visible envelope |
| Encrypted chat over onion with blind tokens | Correctly encrypted content is hidden | Through accepted Tor ingress | Through blind tokens | Gateway plaintext, size and timing |
| Private retrieval/files | Yes, in memory | Not supplied by this adapter alone | Uses its supported keyed billing path | Multiple provider calls; no persistent document store |

## 6. The AnyRoute Network

### 6.1 The approved build and signed policy

The network is open for early hosts running the approved Intel TDX build in a supported confidential VM. The recipe is `deploy/network/approved/tdx-qwen2.5-0.5b`. The router publishes signed host policy v1 at `GET /api/v1/network/policy`, with its record in the key transparency log.

Admission and clients verify canonical policy bytes, digest, signature and log evidence under an independently pinned key. The policy requires a quote-bound compose hash but does not approve a compose manifest; host-specific configuration still needs deployment review. Policy acceptance does not prove archive-to-image reproducibility, actual engine execution or every operational promise.

### 6.2 Automatic admission and renewal

Joining hosts present an HTTPS endpoint and operator and payout identities. Pending hosts are not routable. Admission checks fresh evidence, quote bindings, the signed policy and sanctions screening of operator and payout addresses. Verified archive, sidecar image, engine and model identifiers must match policy. Claimed GPU evidence is insufficient when policy requires separate verification. Successful admission starts probation; rejection publishes reasons.

Renewal checks current policy and evidence. Neither admission nor a public host record guarantees permanent eligibility. Sanctions screening depends on its implementation, data and updates; it is not a hardware property.

### 6.3 Probation, routing weight and host records

New hosts begin with reduced weight. The default seven-day probation also requires 200 attested successes and observed probe availability of at least 99%; elapsed time alone is insufficient. Routing considers fresh evidence, health, failures and latency, and can assign zero traffic.

Weighting never overrides a requested lane or failed attestation. Bond-aware weighting requires a fresh canonical observation matched to the operator. Public /hosts records distinguish registration from current eligibility and expose admission reasons.

### 6.4 HostBond

HostBond on Robinhood Chain is `0x2921d34fd86d3323a5369a270a82814a74250518`. Bonded hosts require at least 5,000 USDG. Live indexing at `/api/v1/network/bonds` is separate from attestation and admission.

The contract has an unbonding cooldown, slash proposal and dispute process; execution requires a delay and separate owner approval. Operational host-bond slashing is not switched on yet. Collateral is not a guarantee of host behavior. Sourcify source verification identifies deployed code, not appropriate privileged actions or accurate observations; readers still need canonical contract state and index freshness.

### 6.5 Payouts and the network fee

Payouts are not switched on yet; no network host payouts are being made. The planned 5% network fee to purchase and burn $ANYR is also not switched on yet. Code availability does not establish current payments.

Activation requires additional configuration, sanctions checks, anchoring, contract-payment setup and appropriate signers. Fee-burn execution needs its own contracts and signer. Passing safeguards does not itself switch a feature on.

### 6.6 Joining

Prepare the approved confidential VM, supply the sidecar credential, inspect evidence and run the published `join.mjs` with operator and payout information, following /network and the recipe. The program is at `web/public/network/join.mjs`. Keep credentials in documented private files, outside public receipts, reports and host descriptions.

### 6.7 Live network statistics

The /network page reads `GET /api/v1/network/stats`, switched on at anyroute.tech: hosts by status, attested now, models on admitted hosts, bonds, waitlist interest and policy version. Model counts are not throughput; interest is not admission.

Public-lane token totals use coarse 100,000-token ranges over retained seven- and thirty-day windows, currently “No data yet”. Missing records do not establish zero activity. These ranges are not differential privacy or complete history after expiry. Private-lane totals are not assigned to hosts by this endpoint. Aggregate counts do not prove an individual host's current eligibility; bond-index and attestation freshness remain separate.

## 7. Agents: the v5 control surface

### 7.1 The rulebook

The hosted agent control surface is switched on at `/agents` and `/api/v1/agents`. The feature generation is called v5; the serialized rulebook schema has its own version field, currently version 1. These version numbers describe different things and should not be substituted for each other.

A rulebook describes permitted or denied models, allowed lanes, declared tool identifiers, working windows, output bounds and budget caps per request, hour, day and week. Canonical serialization produces a policy hash so decisions can name the rules they evaluated. Unknown schema fields are refused rather than silently accepted as effective controls.

The router evaluates applicable policies when reserving spending capacity and serializes decisions with account-level locking. Parent and session policies can apply together. This prevents a self-check by the agent from becoming the final authority: the service admitting the call evaluates the current rules and state. It also limits races between parallel requests that might otherwise each see an apparently available budget.

### 7.2 Stop and ask-first controls

The kill switch stops the next admitted request. The owner resumes the agent. It is not a mechanism for recalling an answer already delivered or guaranteeing cancellation of every in-flight computation. A request already admitted can complete, so operators should distinguish future admission from cancellation and final settlement.

Ask-first approvals appear on `/agents`; owners can link Telegram there with a one-time code and approve or deny through AnyRoute's bot. Approval details pass through Telegram. The same approvals are single use and expire after fifteen minutes under the current default. The stored approval projection contains intent metadata such as model, lane, output bound, declared tools and cost bound. It does not store the prompt or tool arguments. The approval must match the projected intent and remain within its permitted cost when consumed.

Approving an intent does not authorize arbitrary instructions hidden inside the content. Because prompts are absent from the approval binding, two bodies can share the same projected intent. The feature controls router-visible resource authority; it is not a content review signature. Approval also cannot bypass an independent denial or a circuit-breaker kill.

### 7.3 Self-check, ledger and alerts

MCP exposes `anyroute_agent_rules` and `anyroute_agent_check`. An agent can inspect its rules and evaluate a proposed action before making a call. A self-check is advisory because state may change before admission; enforcement still occurs at the router. A useful integration handles a refusal or approval-required response even after a successful earlier check.

The per-agent ledger associates activity with signed receipts and supports CSV and JSON export. Policy events and billing evidence provide different views of activity: decisions describe admission, while generation receipts describe served calls. The ledger does not establish that activity outside AnyRoute was captured, and exporting it can expose operational metadata even without conversation text.

Alerts are available in the `/agents` feed, through the existing spend-alert webhook and through Telegram when the owner uses AnyRoute's bot. Owners who link Telegram can also approve or deny requests there, with the same single-use approval as /agents; the approval details pass through Telegram. Email alerts are not switched on yet. An available notification channel is not interchangeable with an approval channel. Notification delivery can fail independently of a router decision, so enforcement does not rely on a person receiving an alert first.

### 7.4 Circuit breakers and progressive autonomy

Optional breakers constrain minute-level spending and request volume, denials over ten minutes and distinct models over an hour. They use recorded state and open holds, and a trip records the kill state and refuses admission. Breakers restrict authority; they do not create permission. An owner approval cannot override a breaker trip, and resuming does not erase ordinary budget-cap obligations.

Progressive autonomy can increase configured spending caps through rulebook rungs, up to a factor of ten. Advancement depends on the configured time and clean-request thresholds; demotion follows the configured events. Replayed events and retained checkpoints provide the state rather than an agent's assertion that it has behaved well. Rulebooks without autonomy do not acquire automatic cap increases.

### 7.5 Track-record certificates and scope

Track-record certificates are router-signed statements with a fresh pseudonym and a seven-day validity window. Their claims can describe request-count thresholds, active days or periods without recorded denials or kills. Verification checks the signed format, trusted receipt key and time window. It does not independently recreate the router's observations.

These certificates are not zero-knowledge proofs and are not anonymous credentials. The router sees the activity and signs the statement. A fresh pseudonym reduces reuse of one public identifier, but does not prevent correlation by claim combinations, issuance timing or information held by the router. A relying party must trust the issuer for the facts asserted.

All agent enforcement described here applies to requests through AnyRoute. There is no on-chain enforcement of the rulebook and no agent-to-agent payment mechanism in this control surface. External wallets, tool execution and unrelated endpoints remain outside this boundary. The built agreement system described below is a separate boundary and is not switched on at anyroute.tech.

### 7.6 Opt-in profiles and directory

Profiles and /agents/directory are switched on. Owners choose publication and the rulebook summary. Random slugs never expose the key hash. Profiles include the latest valid track-record certificate, A2A-style card JSON and MCP tool `anyroute_agent_directory`. Discovery does not verify capabilities or establish an invocation endpoint.

Owner-written fields can identify people. Publication links a certificate's pseudonym to the profile; certificates remain router-signed observations, not independent proof. Unpublishing cannot recall retained copies. Profiles change neither enforcement scope nor prompt readers.

### 7.7 Available sealed agent hosting

The owner builds and publishes an agent sidecar image using `deploy/agents/sealed`. The router verifies a registered agent's TDX quote and shows “Sealed · attested” on /agents. Hosting is available, but no sealed agent is registered at anyroute.tech yet.

Trust includes Intel TDX, firmware, the guest OS, verifiers, key-release authorization and measured code. Attestation does not audit code, prove exclusive credential possession or prove every later request came from the VM. External tools need separate review. Ordinary requests remain readable in router memory; sealed hosting alone does not enable encrypted chat.

### 7.8 Agreements between agents

AgreementEscrow, DisputeOracle, the indexer, evidence handling, jury, API, MCP tools and /agents tab are built. The service and contracts are live at anyroute.tech: AgreementEscrow `0xefd8d05f45b8a92aa3b3ef3a7db4c9d3a21f7c96` and DisputeOracle `0xcdeddcea1e039e72868bb8af3206af2647afda5a` on Robinhood Chain, both Sourcify-verified (exact match). Automatic jury rulings are switched on (two of three attested models; a hung jury goes to the panel).

USDG escrow holds individual milestones: delivery digests, payer release, payee claims after unanswered review and reclaiming undelivered work after the deadline. Disputes lock their milestone. Model-jury rulings refund, pay or split; a complete hung tally can reach a separate panel. After 30 days unruled under the deployment default, anyone can transact to settle 50/50, with odd base units to the payee. Jury and panel cannot extend expiry.

The router controls jury signing keys; distinct models can share operators or hardware. Contracts verify authorized signatures, not model execution, attestation or verdict correctness. Panel decisions remain trusted. Malicious or missing evidence and unavailable signers can impede resolution. Both parties, the router and jury models can read evidence, encrypted at rest. Wallet addresses, amounts, digests and rulings are public on chain. Agreements add no prompt encryption or rulebook enforcement over outside transactions.

## 8. $ANYR mechanics

### 8.1 Identity and inference payment

The official $ANYR contract on Robinhood Chain is `0xa4dDF89A40A35264E9D7F896a1ef01C59b1e977a`. This paper refers only to that token. Its role here is described through payment, escrow and contract accounting mechanics implemented in the repository. Token possession is not a substitute for model eligibility, attestation evidence, network admission or an agent approval.

The escrow code supports $ANYR deposits as an inference funding method. Once a transfer satisfies finality and canonical-chain checks, the sending wallet's account can receive inference credit. The accounting conversion uses the lower of spot and a time-weighted pool observation, applies the configured haircut and enforces a per-deposit cap. These are conversion safeguards, not forecasts or claims about the token's future behavior.

If the pool history, liquidity, deviation or source checks do not provide a usable accounting input, the deposit remains pending instead of receiving an invented credit. Excess above the configured cap is flagged for operator review rather than silently credited. Credited transfers are rechecked for reorganization; a compensating debit reverses a credit whose supporting transfer is no longer canonical. A negative balance blocks further spending until covered.

Deposited tokens remain in escrow and the resulting credit is for inference. The flow creates an operational relationship with the escrow operator. It is separate from x402 USDG authorization and from blind-token redemption. A wallet-linked escrow deposit does not itself hide who funded an account.

### 8.2 Staking and buyback code

The repository also implements `AnyrStaking`. Its code records deposits, optional provider attribution, an unstake cooldown and allocation accounting. The contract's margin notification splits the notified USDG amount between operations and a buyback balance. A permitted keeper can swap from that balance subject to the daily cap and an on-chain minimum-output oracle; the contract measures actual received tokens by balance change before allocation.

Bought tokens in this staking mechanism are allocated through the contract's accounting. They are not the planned network-fee burn. Unstaking removes the requested amount from active stake immediately and places it in a seven-day cooldown. Allocation and unclaimed balances have explicit accounting rather than being inferred from a displayed token balance alone.

Buyback execution refuses a missing oracle, zero or stale observations, an invalid minimum output, excess daily usage and insufficient actual output. The router keeper adds configuration and oracle-agreement checks. Production contract mode requires reviewed deployment evidence for the configured oracle; escrow payment mode must not run this job.

The hosted activation state of the staking buyback job is not established by the deployment facts used for this paper. This section describes inspectable repository mechanics and makes no claim of current executions or distributions. An operator must establish the actual contract addresses, roles, reviewed oracle and job configuration before describing that path as switched on.

### 8.3 The separate planned network-fee burn

The network payout design includes a 5% fee intended to purchase and burn $ANYR. Network payouts and this burn path are not switched on yet. The design has separate accrual, payout, fee-burn configuration and execution code; the presence of those components does not establish current token purchases, burns or transfers to hosts.

HostBond uses USDG collateral, and the router's inference settlement unit is USDG. Those distinctions matter when inspecting the system: a host bond is not a $ANYR stake, a prepaid inference credit is not an ownership claim, and a staking allocation is not a burn. This discussion is limited to mechanics. It is not an offer or investment advice.

## 9. Security and trust model

### 9.1 Trust is specific to the claim

The router operator controls routing policy, accounting configuration and service operation. On ordinary paths it can read request text in memory. On encrypted chat it sees the routing envelope, authentication and usage metadata, and can affect availability and forwarding. Client-side verification reduces the authority to substitute accepted cryptographic evidence, but cannot force an operator to serve a call.

Hardware vendors and the attestation chain establish the meaning of hardware evidence. Verifier implementations decide whether that evidence satisfies a policy. Hosts operate the serving environment; measurements and pinned keys constrain particular substitutions but do not prove perfect application behavior. Witnesses or Rekor provide independent publication checks only when clients actually verify them under a suitable trust policy.

Payment and chain paths add trust in contract code, privileged roles, oracle inputs, canonical-chain observation and ledger integration. An external explorer or source-verification record is a useful inspection tool, not a replacement for those checks. The signed receipt key establishes an issuer, while the content of the receipt still depends on the observations and code behind that issuer.

| Threat or failure | Existing boundary | Remaining trust or limit |
| --- | --- | --- |
| Endpoint substituted after quote inspection | Quote-bound TLS key and pinned transport | Verifier, accepted measurements and transport implementation |
| Old or incompatible host evidence | Freshness, binding and signed-policy checks | Evidence service and acceptance policy |
| Silent reduction of requested privacy | Lane and disclosure filters refuse when unsatisfied | Correct client request and router implementation |
| Router reads ordinary prompts | Explicit disclosure; encrypted-chat path for content separation | Ordinary lanes still expose text in memory |
| Encrypted content sent to the wrong gateway | Client attestation verification and reply checks | Independently trusted verifier and gateway policy |
| Split history of keys | Consistency checks, witness policy or Rekor anchoring | Independent pins, monitoring and non-collusion assumptions |
| Replayed payment or approval | Authorization, redemption and single-use state checks | Storage consistency and implementation correctness |
| Parallel agent overspending | Account locks, holds and router rulebook admission | Estimates, later settlement and activity outside the router |
| A host performs badly after admission | Probation, renewal and health-based weight | Observed workload; bond slashing is not switched on yet |
| Activity correlated without direct identifiers | Tor ingress and blinded payment credentials | Timing, sizes, identifying content and external observations |
| Document retention claim widened too far | Request-scoped retrieval and explicit inventory | Router/provider plaintext processing and other enabled stores |
| Misleading execution claims from hashes | Versioned evidence and explicit declaration limits | Build reproducibility and actual execution need further review |

### 9.2 Startup guards and independent parties

Production configuration contains refusal conditions for incomplete deployments. An enabled key log needs a stable configured signing key and an independent checkpoint mechanism: a sufficient witness configuration or public Rekor anchoring with its dedicated signing configuration. If witnesses are also configured, their required checks remain relevant; public anchoring is not a reason to ignore a pinned witness policy.

The OHTTP gateway code requires blind tokens and checks the number of relay operators other than the gateway operator. The default minimum is two. Merely listing endpoints run by one operator does not establish the required operator separation. These are checks of configured operator identities and endpoints, not a proof that nominally separate organizations never cooperate.

The live onion path is an explicit alternative ingress, with its own onion address, ingress secret and blind-token requirements. It does not weaken the OHTTP relay guard or make a direct clearnet request unlinkable. This paper establishes hosted Tor use; it does not establish that the optional OHTTP relay deployment is switched on.

Enabled encrypted chat in production requires a configured approved gateway and attestation endpoint, and startup also checks the database provider. Network admission needs the signed policy and transparency log; production settings require supporting replay-protection storage and appropriate verifier endpoints. Payout and slashing activation have additional role and signer guards. A safe startup does not by itself establish successful runtime verification, working infrastructure or independent operation of every external party.

### 9.3 Self-hosting defaults

Feature defaults describe a fresh self-hosted configuration, not the activation state of the hosted service. The following flags default to false; several are explicitly switched on in the hosted deployment described here.

| Flag | Default | Hosted status or boundary |
| --- | --- | --- |
| `E2EE_PASSTHROUGH_ENABLED` | `false` | Encrypted chat switched on |
| `ANYROUTE_FEATURE_BLIND` | `false` | Blind tokens switched on |
| `UNLINKABLE_VIA_ONION` | `false` | Hosted onion unlinkable ingress switched on |
| `TLOG_ENABLED` | `false` | Key log switched on |
| `TLOG_REKOR_ENABLED` | `false` | Hosted Rekor anchoring switched on |
| `HOST_ANCHOR_ENABLED` | `false` | Per-host receipt anchoring switched on |
| `NETWORK_POLICY_ENABLED` | `false` | Signed host policy switched on |
| `NETWORK_HOSTS_ENABLED` | `false` | Approved-build admission switched on |
| `NETWORK_BONDS_ENABLED` | `false` | HostBond indexing switched on |
| `NETWORK_STATS_ENABLED` | `false` | Network statistics switched on |
| `AGENT_POLICY_ENABLED` | `false` | Agent rulebook control surface switched on |
| `AGENT_PROFILES_ENABLED` | `false` | Opt-in profiles and directory switched on |
| `AGENT_SEALED_ENABLED` | `false` | Registration available; no registered sealed agent yet |
| `TELEGRAM_LINKING_ENABLED` | `false` | Telegram linking and approvals switched on |
| `AGENT_AGREEMENTS_ENABLED` | `false` | Switched on at anyroute.tech; contracts deployed on Robinhood Chain |
| `AGENT_AGREEMENTS_RULINGS_ENABLED` | `false` | Switched on at anyroute.tech, only on the isolated jury worker |
| `NETWORK_PAYOUTS_ENABLED` | `false` | Not switched on yet |
| `NETWORK_FEE_BURN_ENABLED` | `false` | Not switched on yet |
| `NETWORK_SLASHING_ENABLED` | `false` | Not switched on yet |
| `OHTTP_ENABLED` | `false` | Repository relay path; hosted activation not established here |

## 10. Open source and verification

### 10.1 Inspect the implementation and license boundaries

The repository exposes the router, sidecar, relay, contracts, client code, deployment recipes and public specification. Each component has an inspectable implementation. The SEAL specification uses Apache-2.0; the repository's root license is PolyForm Noncommercial. Inspectability does not mean every component has identical licensing or unrestricted commercial reuse.

The client SDK implementations are in `packages/`. Package releases on npm and PyPI are not switched on yet. A source tree and a package-registry release are different distribution states. A reader can inspect the verifier and receipt code without assuming that a published registry package already carries it.

### 10.2 Verify a call as several independent steps

The `/verify` page provides an attestation inspection surface, `/hosts` exposes network records, and `/keep` documents retained information. The key-log endpoints expose checkpoints and proofs. Together these give a reader more than a provider label, but verification remains a set of specific checks rather than one universal badge.

For an attested ordinary call, a reviewer can identify the serving provider from the receipt, check its signed claims, inspect accepted attestation evidence and bound measurements, establish the signing key's identity through configured transparency checks and inspect any available anchor proof. None of those steps changes the fact that ordinary routing read the text. Content separation requires the encrypted-chat path and its client-side checks.

For encrypted chat, the client must verify fresh gateway evidence under its own acceptance policy before encrypting, and verify the reply and gateway receipt afterward. For an unlinkable exchange, the accepted ingress and blind-token requirements must also hold. For a network host, inspect the signed policy version, admission reasons and current bond and health records rather than infer eligibility from a name in a list.

A useful review keeps evidence types distinct: a hash identifies bytes; a signature identifies a signing key; a quote binds measurements and keys under an attestation chain; a log proof establishes inclusion or consistency; a chain anchor establishes a published commitment. None alone establishes all the others. HostBond's Sourcify verification similarly identifies deployed source without proving every operational claim about the network.

## 11. What's next

Next are deploying the agreements contracts and switching agreements on; agent wallets with on-chain rules; GPU hosts on the network; and network payouts. The agreement code and service already exist, but contract deployment and activation remain separate steps. Agent wallets would add an on-chain spending boundary beyond today's router-enforced rulebook.

Current network admission covers the approved Intel TDX build; existing attested inference providers do not establish GPU-host network admission.

Several repository paths await activation rather than a new concept: network host payouts, the planned 5% network-fee purchase and burn of $ANYR, host-bond slashing, email alerts and SDK releases on npm and PyPI are not switched on yet. Their presence in code does not change their status. Activation must satisfy the relevant configuration, role and evidence requirements before public claims change.

## 12. References

### 12.1 Protocol documents

| Reference | Scope |
| --- | --- |
| [SEAL overview and status](spec/README.md) | Lanes, parties, honest limits and implementation status |
| [0001: Attestation](spec/0001-attestation.md) | Quote bindings, measurements, key transparency and host admission policy |
| [0002: Transport](spec/0002-transport.md) | Direct HPKE, gateway encryption, relay transport and their different boundaries |
| [0003: Credits](spec/0003-credits.md) | Blind issuance, redemption and unlinkable payment requirements |
| [0004: Receipts](spec/0004-receipts.md) | Signed formats, verification and anchoring |
| [0005: Policy](spec/0005-policy.md) | Measured content-policy mechanism and limits |

### 12.2 User and operator documentation

Read the [router overview](README.md), [lanes](https://anyroute.tech/docs/#lanes), [Tor unlinkable access](https://anyroute.tech/docs/#unlinkable-tor), [encrypted chat](https://anyroute.tech/docs/#e2ee-phala), [key log](https://anyroute.tech/docs/#key-log), [receipts](https://anyroute.tech/docs/#receipts), [receipt privacy labels](https://anyroute.tech/docs/#what-we-saw), [retrieval](https://anyroute.tech/docs/#rag) and [SDK verification](https://anyroute.tech/docs/#sdk). The [SEAL page](web/app/seal/page.jsx), [data inventory](web/app/keep/page.jsx), [verification page](web/app/verify/page.jsx), [host records](web/app/hosts/page.jsx) and [agent controls](web/app/agents/page.jsx) provide related inspection surfaces.

Read the [network statistics](https://anyroute.tech/docs/#network-stats), [agent profiles](https://anyroute.tech/docs/#agent-profiles), [sealed agents](https://anyroute.tech/docs/#sealed-agents) and [agreements](https://anyroute.tech/docs/#agreements) sections for their distinct availability and trust boundaries. The [sealed agent recipe](deploy/agents/sealed/README.md) describes owner-provided deployment.

The [approved host recipe](deploy/network/approved/tdx-qwen2.5-0.5b/README.md), its [compose template](deploy/network/approved/tdx-qwen2.5-0.5b/docker-compose.template.yml) and the [join program](web/public/network/join.mjs) describe the currently admitted build and join process. The [HostBond Sourcify record](https://sourcify.dev/server/v2/contract/4663/0x2921d34fd86d3323a5369a270a82814a74250518) is the source-verification reference for that deployed contract.

### 12.3 Implementation references

| Area | Source |
| --- | --- |
| Routing and disclosure | [Selection](src/router/select.ts), [disclosure](src/router/disclosure.ts), [chat](src/api/chat.ts) |
| Accounting and x402 | [Ledger](src/ledger/ledger.ts), [x402](src/pay/x402.ts), [escrow](src/pay/escrow.ts) |
| Sidecar evidence | [Attestation](sidecar/src/attest.ts), [source bindings](sidecar/src/source-bindings.ts), [hardware evidence](sidecar/src/attestation/tdx.ts) |
| Router attestation | [Attestor](src/services/attestor.ts), [verifiers](src/services/attestor-verifiers.ts), [measurement bundles](src/services/measurement-bundles.ts) |
| Keys and receipts | [Transparency log](src/tlog/log.ts), [Rekor anchoring](src/tlog/rekor.ts), [receipt signer](src/receipts/signer.ts), [receipt v2](src/receipts/v2.ts) |
| Privacy inventory | [Schema](src/db/schema.ts), [inventory](src/privacy/inventory.ts), [outside storage and readers](src/privacy/outside.ts), [receipt descriptions](src/privacy/tables/receipts.ts) |
| Encrypted chat and retrieval | [Adapter](src/api/e2ee.ts), [gateway](src/e2ee/gateway.ts), [client](packages/client/src/e2ee.ts), [retrieval adapter](src/api/rag.ts) |
| Host admission and weight | [Admission](src/network/admit.ts), [policy](src/network/policy.ts), [publication](src/network/publication.ts), [weight](src/network/weight.ts), [weight settings](src/network/weight-config.ts) |
| Bonds and inactive payment paths | [HostBond](contracts/src/seal/HostBond.sol), [indexer](src/network/bond-indexer.ts), [payout](src/network/payout.ts), [fee burn](src/network/fee-burn.ts), [slashing](src/network/slashing.ts) |
| Agent authority | [Policy schema](src/agents/policy.ts), [evaluation](src/agents/evaluate.ts), [enforcement](src/agents/enforce.ts), [approvals](src/agents/approvals.ts), [MCP](src/api/mcp-agent.ts) |
| Agent records and controls | [Ledger](src/agents/ledger.ts), [alerts](src/agents/alerts.ts), [breakers](src/agents/BREAKERS.md), [autonomy](src/agents/autonomy.ts), [certificates](src/agents/record-certificate.ts) |
| Token contract mechanics | [Staking](contracts/src/AnyrStaking.sol), [keeper](src/services/buyback.ts), [TWAP accounting](src/chain/twap.ts) |
| Production defaults and guards | [Loader](src/config.ts), [encrypted gateway](src/e2ee/config.ts), [host admission](src/network/host-config.ts), [payout activation](src/network/payout-config.ts), [bond activation](src/network/bond-config.ts) |

References identify the repository implementation and its public documentation. A specification target is not evidence of activation; a source file is not evidence of a live transaction. Where this paper establishes hosted activation, the accompanying limits still apply.
