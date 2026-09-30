"use client";
import { Button } from "../../components/UI";
import { HostCopy, HostAction } from "./NetworkAdmission";
import Waitlist from "./Waitlist";
import Join from "./Join";
import s from "./network.module.css";

const FAQ = [
  ["Do I need to do KYC?", "The planned program has no KYC and no contracts. Your machine would prove itself through hardware attestation. When payouts exist, payout addresses would be screened against the public sanctions list."],
  ["What hardware do I need?", "For GPU models: an NVIDIA H100, H200 or B200-class GPU that supports confidential-computing mode, on an Intel TDX or AMD SEV-SNP host. For small models, a TDX or SEV-SNP CPU server may be enough. The checker gives hints; attestation would establish eligibility."],
  ["How would I get paid?", "Paid per token served, in USDG, claimable on-chain. This is a plan, not a live program. No amounts are promised. The form lets you record a payout preference."],
  ["Can I see the prompts my machine serves?", "The planned design processes prompts inside the enclave, with attestation of the measured code intended to protect that memory from the host operator. This depends on the hardware, measured software and its policy. AnyRoute’s router still reads requests in memory; the enclave runs the model."],
  ["When does it launch?", "There’s no date yet. We’re checking interest first, and your sign-up helps decide when host onboarding opens. Until then, outside hosts can’t join."],
  ["Can I join without leaving contact details?", "Yes. Contact is optional. Keep your entry id and delete code to remove your entry at any time. We delete the list when the program launches or is cancelled."],
];
const OPEN_FAQ = [
  [
    "Do I need to do KYC?",
    "No KYC and no contracts. Your machine proves itself through hardware attestation. Payout addresses are screened against the public sanctions list."
  ],
  [
    "What hardware do I need?",
    "For GPU models: an NVIDIA H100, H200 or B200-class GPU that supports confidential-computing mode, on an Intel TDX or AMD SEV-SNP host. For small models, a TDX or SEV-SNP CPU server may be enough. The checker gives hints; attestation establishes eligibility against the published host policy."
  ],
  [
    "How do I get paid?",
    "Paid per token served, in USDG, claimable on-chain. No amounts are promised. Set your payout address with the join command."
  ],
  [
    "Can I see the prompts my machine serves?",
    "The enclave processes prompts, with attestation of the measured code intended to protect that memory from the host operator. This depends on the hardware, measured software and its policy. AnyRoute’s router still reads requests in memory; the enclave runs the model."
  ],
  [
    "Is it open?",
    "Yes, for early hosts running an approved build (see the host policy at /api/v1/network/policy). New hosts start on probation."
  ],
  [
    "Can I join without leaving contact details?",
    "Yes. Contact is optional. Keep your entry id and delete code to remove your waitlist entry at any time. Hosting signup requires an operator wallet, endpoint, payout address and model ids; contact is optional."
  ]
];
export default function NetworkContent({ sha, joinSha }) {
  return <main className="page-main" id="content">
    <div className="page-title" data-reveal><span className="eyebrow"><HostCopy closed="ANYROUTE NETWORK · WE’RE GAUGING INTEREST" open="ANYROUTE NETWORK · OPEN FOR EARLY HOSTS" /></span><h1>Private AI needs<br />private hardware.<br /><em>Yours counts.</em></h1><p><HostCopy closed="The AnyRoute Network is coming: confidential hardware, owned by anyone, serving private AI and paid per token served. Hosting isn’t open yet. Join the waitlist and check your hardware now." open="Hosting is open for early hosts running an approved build. Check your hardware, then join with one command." /></p><div className="button-row"><HostAction /><Button href="#readiness" secondary>Check your hardware</Button></div><p><HostCopy closed={null} open={<>Not ready yet? <a href="#waitlist">Join the waitlist.</a></>} /></p></div>
    <div className="side-layout"><nav className="side-nav" aria-label="Sections"><span className="side-nav-label">On this page</span>{[["how", <HostCopy closed="How it will work" open="How it works" />], ["today", "What’s true today"], ["who", "Who it’s for"], ["readiness", "Readiness checker"], ["waitlist", "Join the waitlist"], ["faq", "FAQ"]].map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}</nav>
    <article className={`page-body prose ${s.body}`}>
      <section id="how"><span className="eyebrow"><HostCopy closed="THE PLAN" open="HOW IT WORKS" /></span><h2>Your hardware proves what it runs.</h2><p><HostCopy closed="No KYC. No contracts. The machine would prove itself. This describes the proposed program; hosting and payouts are not available." open="No KYC. No contracts. The machine proves itself through hardware attestation and the published host policy. New hosts start on probation." /></p><ol className="case-steps">{[["Join with one command", <HostCopy closed="When onboarding opens, an installer would connect your machine." open="The installer connects your machine; the join command submits it for admission." />], ["Prove the hardware", <HostCopy closed="Attestation would check the enclave and the measured software before traffic is accepted." open="Attestation checks the enclave and the measured software against the published host policy before traffic is accepted." />], ["Serve private traffic", <HostCopy closed="The enclave would run the model. AnyRoute’s router still reads requests in memory." open="The enclave runs the model. AnyRoute’s router still reads requests in memory." />], ["Paid per token served", <HostCopy closed="The plan is USDG payouts for tokens served, claimable on-chain." open="Paid per token served, in USDG, claimable on-chain. No amounts are promised." />]].map(([title, text], i) => <li className="case-step is-in" key={title}><span className="step-n">STEP {i + 1}</span><h3>{title}</h3><p>{text}</p></li>)}</ol></section>
      <section id="today"><span className="eyebrow">CURRENT SERVING</span><h2>There’s already a foundation.</h2><p>AnyRoute’s attested lane already serves 23 open models inside hardware enclaves, with a signed receipt for each call. <a href="/seal/">See the serving protocol and current status</a>.</p><p>Public host measurements and Sigstore records let you inspect what is measured. Receipt roots and anchors make served work checkable where anchoring is switched on. <a href="/verify/">Verify a provider and its evidence</a>.</p><p>A one-command installer exists in the open-source repository. <HostCopy closed="It does not admit outside hosts to a network today." open="Hosts running an approved build can submit their machine for admission." /> Tor onion access with blind tokens separates token issuance from spending; those protections depend on the transport and lane you use. <a href="/seal/">Read the conditions and limits</a>.</p><p>AnyRoute’s router still reads requests in memory; the enclave runs the model. Receipts store hashes, token counts and cost, not prompt text. <a href="/keep/">See the full inventory of what we keep</a>.</p></section>
      <section id="who"><h2>Bring the hardware. Or the demand.</h2><ul><li><strong>Confidential GPU owners and fleet operators:</strong> NVIDIA H100, H200 or B200-class servers with GPU confidential-computing support on Intel TDX or AMD SEV-SNP hosts.</li><li><strong>Confidential cloud users:</strong> rented TDX or SEV-SNP machines with spare capacity. Renting solely to host may not cover your costs.</li><li><strong>Small-server owners:</strong> TDX or SEV-SNP CPU servers for small models.</li><li><strong>Relay operators and witnesses:</strong> record your interest in supporting the proposed network.</li><li><strong>Developers and agents:</strong> tell us you need more private inference capacity.</li></ul></section>
      <section id="readiness"><span className="eyebrow">READ-ONLY · NO NETWORK CALLS</span><h2>What can your machine do?</h2><p>Download the checker, compare its SHA-256 with the value below, inspect it, then run it. It checks guest devices, host support hints and NVIDIA confidential-computing queries. It changes nothing and sends nothing. Kernel log permissions can limit the answer; sudo may reveal more, but the checker never asks for root.</p><pre className={s.code}><code>curl -fsSLO https://anyroute.tech/network/check.sh &amp;&amp; sha256sum check.sh &amp;&amp; sh check.sh</code></pre><p className={s.small}>The command prints the digest before running. Compare the downloaded file before running it; you can perform the three steps separately.</p><dl className={s.digest}><dt>check.sh SHA-256</dt><dd><code data-network-check-sha256={sha}>{sha}</code></dd></dl><p><a href="/network/check.sh">Read or download check.sh</a></p><p><strong>This is a hint.</strong> <HostCopy closed="Real eligibility is proven by attestation when hosting opens." open="Real eligibility is proven by attestation against the published host policy." /> A capability mention or an enabled GPU mode is not proof of an eligible machine. Paste the summary into the form only if you choose.</p></section>
      <section id="waitlist"><span className="eyebrow">WAITLIST</span><h2>Tell us what you’d bring.</h2><p>No names required. Contact details are optional. This form works on this site’s onion address using the same relative API path, with no third-party requests.</p><Waitlist /></section>
      <Join sha={joinSha} />
      <section id="faq"><h2>A few straight answers.</h2>{FAQ.map(([q, a], i) => <details className={s.faq} key={q}><summary><HostCopy closed={q} open={OPEN_FAQ[i][0]} /></summary><p><HostCopy closed={a} open={OPEN_FAQ[i][1]} /></p></details>)}</section>
    </article></div></main>;
}
