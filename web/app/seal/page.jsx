import SealNetworkDocs from "../../components/SealNetworkDocs";
import SealEncryptedChatDocs from "../../components/SealEncryptedChatDocs";
import PageFrame from "../../components/PageFrame";
import { Button } from "../../components/UI";
import { loadSeal, SPEC_LICENSE_URL, SPEC_SOURCE_URL } from "../../lib/seal-spec";
import { renderInline } from "../../lib/spec-markdown";
import SealLive from "./SealLive";
import s from "./seal.module.css";

export const metadata = {
  title: "SEAL: a verifiable privacy layer for open models — Anyroute",
  description:
    "SEAL is Anyroute's public privacy protocol: attested serving, encrypted transport, anonymous credits and a ledger of signed receipts, with measured policy. What each part does, who learns what, the honest limits, and the status of every part as the spec states it.",
};

// Protocol status rows are read from spec/ at build time; the hosted deployment notes describe the enabled paths separately.

const STATE_LABEL = { implemented: "Implemented", planned: "Planned", partial: "Partly built" };
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n) => WORDS[n] ?? String(n);
const listJoin = (items) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`);

function Md({ text, resolveHref, as: Tag = "span", className }) {
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: renderInline(text, { resolveHref }) }} />;
}

/** One line per part of the protocol: how its rows in the status table read, with links to the rows and the doc. */
function PartStatus({ number, rows, docs }) {
  const doc = docs.find((d) => d.number === number);
  const mine = rows.filter((r) => r.spec.includes(number));
  if (!doc || !mine.length) return null;
  const count = (state) => mine.filter((r) => r.state === state).length;
  const off = mine.filter((r) => r.state === "implemented" && r.off_by_default).length;
  return (
    <div className={s.partStatus}>
      <span className={s.partLabel}>
        Status rows for {number} ({mine.length})
      </span>
      <span className={s.marks}>
        {["implemented", "partial", "planned"].map((state) =>
          count(state) ? (
            <span key={state} className={s.mark} data-state={state}>
              {count(state)} {STATE_LABEL[state].toLowerCase()}
              {state === "implemented" && off ? `, ${off} off by default` : ""}
            </span>
          ) : null,
        )}
      </span>
      <span className={s.partLinks}>
        <a href={`#status-${number}`}>See the rows</a>
        <a href={doc.url}>Read {number}</a>
      </span>
    </div>
  );
}

export default function SealPage() {
  const { docs, readme, version, resolveHref } = loadSeal();
  const rows = readme.status;
  const numbered = docs.filter((d) => d.number);
  const firstRow = Object.fromEntries(numbered.map((d) => [d.number, rows.findIndex((r) => r.spec.includes(d.number))]));
  const tally = {
    implemented: rows.filter((r) => r.state === "implemented").length,
    off: rows.filter((r) => r.state === "implemented" && r.off_by_default).length,
    partial: rows.filter((r) => r.state === "partial").length,
    planned: rows.filter((r) => r.state === "planned").length,
  };
  const docLink = (n) => docs.find((d) => d.number === n)?.url || "/spec/";
  const v = version.version ? `v${version.version}` : "draft";

  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">SEAL / PRIVACY PROTOCOL · SPEC {v}</span>
          <h1>
            A verifiable privacy layer
            <br />
            for open models.
          </h1>
          <p>
            SEAL is the privacy expansion of the Anyroute stack: a public protocol and implementation effort for serving open-weight models with a clearer answer to four basic questions.
          </p>
          <div className="button-row">
            <Button href="/spec/">Read the spec</Button>
            <Button href="/whitepaper/" secondary>AnyRoute Whitepaper</Button>
            <Button href="/network/" secondary>AnyRoute Network · open for early hosts</Button>
            <Button href="/hosts/" secondary>Hosts</Button>
            <Button href="/seal/status.json" secondary>
              status.json
            </Button>
          </div>
        </div>

        <div className="side-layout">
          <nav className={`side-nav ${s.nav}`} aria-label="SEAL sections" data-reveal="fade">
            <span className="side-nav-label">On this page</span>
            <a href="#questions">Four questions</a>
            <a href="#design">One request</a>
            <a href="#sidecar">S · Sidecar</a>
            <a href="#transport">E · Transport</a>
            <a href="#encrypted-chat">Encrypted chat</a><a href="#open-network">Open host network</a>
            <a href="#credits">A · Credits</a>
            <a href="#receipts">L · Receipts</a>
            <a href="#policy">Policy</a>
            <a href="#parties">Who learns what</a>
            <a href="#limits">Honest limits</a>
            <a href="#targets">Design targets</a>
            <a href="#status">Status</a>
            <a href="#live">Live here</a>
            <a href="#public-spec">Public spec</a>
            <a href="#larger-point">The larger point</a>
          </nav>

          <article className={`page-body prose ${s.body}`}>
            <h2 id="questions">Four questions.</h2>
            <ol className={s.questions} data-stagger>
              <li data-reveal>What model and software answered the request?</li>
              <li data-reveal>Who could read the prompt while it was processed?</li>
              <li data-reveal>Can payment be separated from the request it paid for?</li>
              <li data-reveal>Can the result be verified without exposing the request itself?</li>
            </ol>
            <p>
              SEAL stands for <strong>S</strong>idecar, <strong>E</strong>2EE relay transport, <strong>A</strong>nonymous credits, and <strong>L</strong>edger of receipts. A fifth component, measured policy, defines any enabled filtering in a way a
              verifier can inspect. The goal is not to ask users to accept a privacy statement. The goal is to give builders a protocol for checking the environment, the keys, the payment credential and the receipt trail themselves.
            </p>
            <h3>Why this expansion matters</h3>
            <p>
              Open models create more choice. A developer can select a model, a host, a region and an inference provider instead of being locked to one closed platform. But that choice also creates a new trust problem: the request often
              crosses several systems operated by different parties.
            </p>
            <p>
              A prompt can reveal unreleased code, research, trading logic, customer records or private instructions. The ordinary setup asks a user to trust the inference provider’s handling of that data while it is in use. For open-model
              infrastructure the underlying questions remain: what is actually running, where does plaintext exist, and what evidence can an independent party inspect?
            </p>
            <p>
              Confidential computing is relevant because it is designed to protect data while it is being used, not just while it is stored or transmitted. NVIDIA describes confidential computing as hardware-level protection for GPU
              execution, memory, register state, model weights and inference prompts, with device attestation used to assess the trustworthiness of the compute environment. SEAL applies that direction to an open-model routing system, then
              joins it with encrypted transport, privacy-preserving credentials and receipts.
            </p>
            <p>
              SEAL is not a claim that all privacy problems are solved today. It is a public working draft ({v}), not an IETF standard, and its repository separates what is implemented from what remains planned in a{" "}
              <a href="#status">status table</a> that this page reads directly.
            </p>

            <h2 id="design">The design in one request.</h2>
            <p>A complete SEAL request is designed to work as a chain of independently checkable steps. First, a client selects the privacy floor it needs. SEAL specifies three lanes:</p>
            {readme.lanes.length > 0 && (
              <div className={s.lanes} data-stagger>
                {readme.lanes.map((lane) => (
                  <article key={lane.lane} className={s.lane} data-reveal>
                    <span className="eyebrow">LANE</span>
                    <h3>
                      <code>{lane.lane}</code>
                    </h3>
                    <dl>
                      <div>
                        <dt>Path</dt>
                        <Md as="dd" text={lane.md.path ?? ""} resolveHref={resolveHref} />
                      </div>
                      <div>
                        <dt>Who can run it</dt>
                        <Md as="dd" text={lane.md.who_can_run_it ?? ""} resolveHref={resolveHref} />
                      </div>
                      <div>
                        <dt>Payment</dt>
                        <Md as="dd" text={lane.md.payment ?? ""} resolveHref={resolveHref} />
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            )}
            <p>
              The router treats a lane as a floor. If it cannot meet a lane’s requirements, it refuses and explains why, rather than silently serving the request below the level it asked for.
            </p>
            {readme.lanesNote.length > 0 && (
              <div className={s.floor}>
                <span className="eyebrow">FROM SPEC/README.MD</span>
                {readme.lanesNote.map((p, i) => (
                  <Md key={i} as="p" text={p} resolveHref={resolveHref} />
                ))}
              </div>
            )}
            <ol className="case-steps" data-progress>
              <li className="case-step" data-reveal>
                <h3>
                  <span className="step-n">01 /</span> Attested serving.
                </h3>
                <p>
                  The request reaches the model-serving environment. SEAL’s Sidecar measures the model weights at boot, checks them against an allow-list, creates its application keys in memory, and obtains hardware-attestation evidence that
                  commits to those keys and measurements. The evidence binds the TLS key, the receipt-signing key, the model digest and configured deployment values into a verifiable record. A client can inspect that evidence, compare the
                  trusted values, and pin the TLS key for the live connection.
                </p>
              </li>
              <li className="case-step" data-reveal>
                <h3>
                  <span className="step-n">02 /</span> Encrypted to the enclave.
                </h3>
                <p>
                  Where encrypted transport is enabled, the client encrypts the request body to an HPKE public key obtained from verified Sidecar evidence. The Sidecar can reject expired, replayed, malformed or undecryptable requests before
                  they reach the model server. It can also encrypt the response in authenticated frames, so a client can detect a truncated encrypted response.
                </p>
              </li>
              <li className="case-step" data-reveal>
                <h3>
                  <span className="step-n">03 /</span> Paid without a name.
                </h3>
                <p>
                  For payment, the design introduces blind-signed credentials. Version 1 uses fixed-value Privacy Pass Blind RSA tokens. The router can validate a token at redemption without the generation record or the receipt naming the
                  buyer; the receipt carries a nullifier and a token key id instead.
                </p>
              </li>
              <li className="case-step" data-reveal>
                <h3>
                  <span className="step-n">04 /</span> A receipt to check.
                </h3>
                <p>
                  The response comes with a signed receipt whose hashes let a client check the exact request and response bytes of the exchange, the model digest, the attestation reference and, where applicable, the policy state. Router
                  receipt roots can be anchored on chain for later inclusion checks.
                </p>
              </li>
            </ol>
            <blockquote className={s.pull}>Privacy, payment and proof should not all depend on one provider’s internal database and one provider’s promise.</blockquote>

            <h2 id="sidecar">
              <span className={s.letter}>S</span> Sidecar and attested serving.
            </h2>
            <p>
              The Sidecar is the model-side gateway. It sits next to an OpenAI-compatible model server and turns an endpoint into something that can expose evidence about its configuration. At boot it calculates a deterministic digest across
              the model files. It refuses to start if its model allow-list is empty or if the measured digest is not on it. It creates TLS and Ed25519 receipt keys in memory, then includes the public keys and measured values in the
              attestation binding.
            </p>
            <p>
              The evidence is served at <code>GET /attest</code>. A verifier can request a fresh nonce-bound quote, recompute the binding digest, compare it with the quote, validate the hardware quote with a verifier of its choice, and
              make sure the live TLS connection uses the key bound in that evidence. Development evidence is labelled as such, and a verifier must reject it outside development.
            </p>
            <p>
              This matters because “private server” is not a useful technical category on its own. A meaningful claim needs evidence about the endpoint, the model identity, the encryption key and the receipt-signing key.
            </p>
            <p>
              There are boundaries. In version 1 the Sidecar’s image digest is an operator declaration, because a process cannot read its own image digest, and the compose hash is hardware-measured only where the platform reports it.
              Model weights are measured at boot and must be mounted read-only. A boot quote shows what booted, not that the same endpoint is still live later; fresh nonce-bound checks and TLS-key pinning are there for freshness.
              Version 1 evidence also does not bind GPU evidence into the Sidecar’s TDX quote. That is a material distinction, and SEAL documents it rather than presenting a CPU-side quote as complete proof of confidential GPU
              execution.
            </p>
            <PartStatus number="0001" rows={rows} docs={docs} />

            <h2 id="transport">
              <span className={s.letter}>E</span> Encrypted transport and network separation.
            </h2>
            <p>
              Encryption and network privacy solve related but different problems. SEAL’s <code>anyroute-hpke/v1</code> mode encrypts the request body from a client directly to an enclave Sidecar, with HPKE over X25519, HKDF-SHA256 and
              AES-128-GCM. The request path and the client’s time are bound as associated data, and the framed, encrypted response lets the client check that the final frame arrived.
            </p>
            <p>
              Separately, the system has an Oblivious HTTP gateway and relay design. The relay drops ordinary client headers, cookies, addresses and query strings before it forwards the encapsulated request. The <code>unlinkable</code>{" "}
              lane requires a blind token and either an independent relay or Tor onion access; a relay run by the gateway’s own operator is explicitly not enough for that lane.
            </p>
            <p>
              The distinction matters because encrypted content alone does not hide every signal: network participants can still observe timing and size. And the path through the router matters as much as the cipher. Whether the router
              carries the client’s inner ciphertext through to the enclave on the <code>attested</code> and <code>unlinkable</code> lanes, or terminates TLS and sees the request, has its own row in the status table, as do chunked
              Oblivious HTTP, padding and fixed-send timing for streamed traffic.
            </p>
            <p>
              That disclosure is not a weakness in the specification. It is exactly why a public specification needs a status table: builders should be able to choose a privacy lane knowing what it guarantees now, not what a roadmap may
              guarantee later.
            </p>
            <SealEncryptedChatDocs />
            <PartStatus number="0002" rows={rows} docs={docs} />

            <h2 id="credits">
              <span className={s.letter}>A</span> Anonymous credits.
            </h2>
            <p>
              Payment can be a privacy leak even if the request body is encrypted. If the account that buys access is attached to every inference call, payment history becomes request history.
            </p>
            <p>
              SEAL’s version 1 credits are Privacy Pass Blind RSA tokens. A buyer submits blinded token material and the issuer signs it without learning the eventual token. When the token is redeemed, the router verifies the credential,
              claims a one-time nullifier so it cannot be spent twice, and bills a pooled internal account. The receipt and the generation record can carry the nullifier and the issuer key id without naming the buyer.
            </p>
            <p>
              These tokens have deliberately narrow economics: they are fixed-value, single-use credentials. A request cannot cost more than the token’s value, and unused value is not returned as change. The more flexible e-cash design,
              with variable value, blinded change, holder locking and a DLEQ proof on every signature, is specified alongside them in <a href={docLink("0003")}>0003</a>.
            </p>
            <p>
              Blind credentials do not erase every correlation risk. Privacy depends on the size and behaviour of the anonymity set; buying and at once spending a distinctive token shrinks it, and a transparent funding rail can still
              identify the buyer at purchase time. A protocol should describe these limits instead of using “anonymous” as a blanket label.
            </p>
            <PartStatus number="0003" rows={rows} docs={docs} />

            <h2 id="receipts">
              <span className={s.letter}>L</span> A ledger of verifiable receipts.
            </h2>
            <p>
              A private system still needs accountability. SEAL’s answer is a receipt that proves facts about an exchange without putting the prompt or the response in the receipt.
            </p>
            <p>
              The version 1 node receipt is signed with Ed25519 and carries hashes of the exact request and response bytes, the model digest, the attestation reference, usage, completion state, and optional fields for an encrypted exchange
              or the classifier. JSON responses carry it in a response header; streamed responses deliver it after the stream’s final event.
            </p>
            <p>
              The router also signs receipts for the generations it settles: the model, provider, cost, latency, lane, attestation details and payment fields. Its signing keys are published and, where a chain is configured, registered on
              chain and never overwritten. Receipt leaves are collected into hourly Merkle trees whose roots are posted on chain where a chain is configured, so a user can verify inclusion against the anchored root.
            </p>
            <p>
              This does not mean a receipt proves that a particular model computed an answer. A valid node receipt proves that a process holding a key bound to a verified quote signed the stated hashes; the broader conclusion about the
              serving environment rests on attestation. An anchor proves inclusion in the anchorer’s tree, not that every possible receipt was included. The purpose of receipts is to turn more of the inference path into an inspectable
              record, not to manufacture certainty where the technology cannot provide it.
            </p>
            <PartStatus number="0004" rows={rows} docs={docs} />

            <h2 id="policy">Measured policy: visible constraints, not hidden filters.</h2>
            <p>
              Open-model infrastructure also has to be clear about policy. A host may need to refuse certain requests, but an opaque filter undermines the promise of an inspectable system.
            </p>
            <p>
              SEAL’s optional classifier runs inside the enclave when it is turned on. Its weights are allow-listed separately and measured at boot. Whether it is on, its digest, the policy hash and the categories behind it are tied to the
              attestation record, so a verifier can see whether filtering was active and what policy was measured.
            </p>
            <p>
              The policy layer is intentionally narrow. It has a built-in minimum category for sexual content involving minors; operators may add publicly described categories, but cannot remove or redefine the built-in one. The
              classifier can check request text and, optionally, response text. It keeps counters, not the request text, the category or the label. A blocked request gets a signed refusal receipt with no content in it.
            </p>
            <p>
              It is not a magic safety solution. The classifier is off unless the operator turns it on, can make false-positive and false-negative decisions, and does not examine images, audio or files in version 1; requests that carry
              them are refused by default or let through, as the measured configuration says. A policy hash proves which policy and classifier were measured, not that the classifier decided perfectly. For users of open and less centrally
              curated model ecosystems, this is the useful direction: constraints should be visible, measurable, and limited to what the system says they are.
            </p>
            <PartStatus number="0005" rows={rows} docs={docs} />

            <SealNetworkDocs />
            <h2 id="parties">Who learns what.</h2>
            <p>
              The parties to a request on the full design, and what each can and cannot learn. This is the design’s intent; the <a href="#status">status table</a> says which parts of it exist, and the honest limits below say where it
              stops.
            </p>
            <div className={`table-wrap ${s.parties}`} role="region" aria-label="Who learns what" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Party</th>
                    <th scope="col">Learns</th>
                    <th scope="col">Does not learn</th>
                  </tr>
                </thead>
                <tbody>
                  {readme.parties.map((p) => (
                    <tr key={p.symbol + p.party}>
                      <td>
                        <span className={s.partyCell}>
                          <span className={s.symbol}>{p.symbol}</span>
                          <Md text={p.md.party ?? ""} resolveHref={resolveHref} />
                        </span>
                      </td>
                      <td data-label="Learns">
                        <Md text={p.md.learns ?? ""} resolveHref={resolveHref} />
                      </td>
                      <td data-label="Does not learn">{p.md.does_not_learn ? <Md text={p.md.does_not_learn} resolveHref={resolveHref} /> : <span className={s.none}>Nothing listed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h2 id="limits">Honest limits.</h2>
            {readme.honestLimitsNote.map((p, i) => (
              <Md key={i} as="p" text={p} resolveHref={resolveHref} />
            ))}
            <ul className={s.limits}>
              {readme.honestLimits.map((l, i) => (
                <Md key={i} as="li" text={l.md} resolveHref={resolveHref} />
              ))}
            </ul>

            <h2 id="targets">Design targets.</h2>
            {readme.guaranteesNote.map((p, i) => (
              <Md key={i} as="p" text={p} resolveHref={resolveHref} />
            ))}
            <dl className={s.targets}>
              {readme.guarantees.map((g) => (
                <div key={g.id}>
                  <dt>{g.id}</dt>
                  <Md as="dd" text={g.md} resolveHref={resolveHref} />
                </div>
              ))}
            </dl>

            <h2 id="status">What exists today, and what remains planned.</h2>
            <p>SEAL is most useful when its present state is described accurately, so this table is not written for this page. It is read from the spec’s own status table when the site is built, row for row.</p>
            <div className="note">
              <strong>Implemented</strong> means code and validation in the repository. That is not the same as deployed or switched on. <strong>Planned</strong> means a public design target, not a live guarantee.
              {readme.statusNote.length > 0 && (
                <>
                  {" "}
                  The spec puts it this way: <Md text={readme.statusNote.join(" ")} resolveHref={resolveHref} />
                </>
              )}
            </div>
            <p className={s.tally}>
              {rows.length} rows: {tally.implemented} implemented{tally.off ? ` (${tally.off} of them off by default)` : ""}
              {tally.partial ? `, ${tally.partial} partly built` : ""}, {tally.planned} planned. Source:{" "}
              <a href="/spec/#status-of-this-repository">spec/README.md, Status of this repository</a>.
            </p>
            <div className={`table-wrap ${s.statusWrap}`} role="region" aria-label="Status of each part" tabIndex={0}>
              <table className={s.status}>
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">Spec</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
                    const anchors = numbered.filter((d) => firstRow[d.number] === i).map((d) => d.number);
                    return (
                      <tr key={i} id={anchors.length ? `status-${anchors[0]}` : undefined} data-state={row.state}>
                        <td>
                          {anchors.slice(1).map((n) => (
                            <span key={n} id={`status-${n}`} />
                          ))}
                          <Md text={row.md.part} resolveHref={resolveHref} className={s.part} />
                          {row.md.where && <Md text={row.md.where} resolveHref={resolveHref} className={s.where} />}
                        </td>
                        <td className={s.specCell} data-label="Spec">
                          {row.spec.map((n) => (
                            <a key={n} href={docLink(n)}>
                              {n}
                            </a>
                          ))}
                        </td>
                        <td data-label="Status">
                          <span className={s.state} data-state={row.state}>
                            <Md text={row.md.status} resolveHref={resolveHref} />
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <h2 id="live">Implemented is not the same as switched on.</h2>
            <p>
              The table above is about the repository. This panel is about the router serving this page: what it reports about itself right now in its public status document. Anything it reports as off says so.
            </p>
            <p>Encrypted chat and automatic host admission are switched on at anyroute.tech. Bonds are indexed from HostBond; payouts, fee buy-and-burn and slashing are not switched on yet. The live panel below reports the router’s current status.</p>
            <SealLive />

            <h2 id="public-spec">Why a public specification changes the ecosystem.</h2>
            <p>
              The <code>spec/</code> folder is licensed under{" "}
              <a href={SPEC_LICENSE_URL} rel="noopener noreferrer" target="_blank">
                Apache-2.0
              </a>
              , even though the rest of the repository keeps its own source-available license. The {count(numbered.length)} RFC-style documents describe {listJoin(numbered.map((d) => d.shortTitle.toLowerCase()))} in a form third parties can
              review or implement without treating Anyroute’s codebase as the only source of truth. That matters for builders in three ways.
            </p>
            <div className={s.three} data-stagger>
              <article data-reveal>
                <span className="eyebrow">01 / VOCABULARY</span>
                <p>A shared vocabulary. A model host, SDK author, relay operator, wallet developer and auditor can reason about the same fields, lane rules, key history, receipts and verification steps.</p>
              </article>
              <article data-reveal>
                <span className="eyebrow">02 / BOUNDARIES</span>
                <p>
                  Inspectable boundaries. A project can decide whether the present HPKE path, a particular attestation configuration or the current blind-token model is enough for its use case, without inferring privacy properties from a
                  marketing page.
                </p>
              </article>
              <article data-reveal>
                <span className="eyebrow">03 / COMPOSITION</span>
                <p>
                  Composable integration. A model host can run an OpenAI-compatible endpoint behind a Sidecar, a client can check attestation evidence and receipts, a payment tool can handle blind credentials, and a relay can operate
                  independently. Not every part has to be run by the same company for the protocol to make sense.
                </p>
              </article>
            </div>
            <div className={s.builders}>
              <span className="eyebrow">FOR BUILDERS</span>
              <ul>
                <li>
                  <a href="/spec/">The specification</a>, rendered from <code>spec/</code> ({docs.length} documents, {v}).
                </li>
                <li>
                  <a href="/seal/status.json">
                    <code>/seal/status.json</code>
                  </a>
                  : lanes, design targets, parties, honest limits and every status row as JSON, built from the same files.
                </li>
                <li>
                  <a href={SPEC_SOURCE_URL} rel="noopener noreferrer" target="_blank">
                    The source on GitHub
                  </a>
                  , and <a href="/verify/">Verify</a> to check a provider’s attestation and a receipt in your browser.
                </li>
                <li>
                  <a href="/keep/">What we keep</a>: every table, column, Redis key and log line the router has, generated from its schema.
                </li>
              </ul>
            </div>

            <h2 id="larger-point">The larger point.</h2>
            <blockquote className={s.pull}>Open models should not require open exposure.</blockquote>
            <p>More broadly, neither model access nor privacy should be decided by whether a user is willing to trust a server operator they cannot inspect.</p>
            <p>
              SEAL is Anyroute’s effort to give open-model infrastructure a verifiable privacy layer: prove the serving environment where possible, encrypt the request path where implemented, separate payment from request history where blind
              credentials support it, publish the policy, and return receipts that users can inspect later.
            </p>
            <p>
              The protocol is still early. Its strongest claims are the ones marked implemented above, because a builder can check them. Its most ambitious outcome, an end-to-end unlinkable lane that combines independent relay transport,
              encrypted requests through the router, attested execution and blind e-cash, depends on every one of those rows, and the table, not this page, says how far along each one is.
            </p>
            <p>
              That is the right posture for infrastructure of this kind. Build the critical pieces in public. Specify the rest in public. Mark the difference. Then let builders, model hosts and users verify the system as it grows.
            </p>
          </article>
        </div>
      </main>
    </PageFrame>
  );
}
