"use client";
import { HostCopy } from "./NetworkAdmission";
import s from "./network.module.css";

export default function Join({ sha }) {
  return <section id="join"><span className="eyebrow">HOST REGISTRATION</span><h2><HostCopy closed="When hosting opens" open="Join as a host" /></h2>
    <p role="status"><HostCopy closed={<><strong>Hosting isn’t open yet.</strong> These commands are for when host registration opens; they do not admit a host while registration is closed.</>} open={<><strong>Host registration is open.</strong> Admission requires fresh hardware attestation and the published host policy. New hosts start on probation.</>} /></p>
    <p><strong>Run the approved build.</strong> The published host policy (<code>/api/v1/network/policy</code>) admits one build today: Intel TDX in a dstack confidential VM (for example Phala Cloud) running the pinned sidecar, llama.cpp and Qwen2.5 0.5B. The exact recipe is open source: <a href="https://github.com/AnyRouteRH/AnyRoute/tree/main/deploy/network/approved/tdx-qwen2.5-0.5b">deploy/network/approved/tdx-qwen2.5-0.5b</a>. Other builds, including ones made with the general installer <code>deploy/seal/install.sh</code>, are refused with the reason until the policy lists them.</p>
    <pre className={s.code}><code>{'phala deploy -n my-anyroute-host -c docker-compose.yml -t tdx.small --wait'}</code></pre>
    <p>Then download <a href="/network/join.mjs">join.mjs</a>, compare its SHA-256 below and inspect it before running. Requires Node 22 or later. Replace the capitalized values with your host settings and model ids. Keep the operator private key and sidecar API key in separate files readable only by you. The sidecar must already hold the SHA-256 of the same API key in its auth.keys configuration.</p>
    <pre className={s.code}><code>{'node join.mjs --key-file /path/to/operator.key --api-key-file /path/to/sidecar.key --name HOST_NAME --endpoint https://SIDECAR --payout-address 0xPAYOUT_ADDRESS --models MODEL_ID'}</code></pre>
    <p><strong>Use a dedicated operator wallet, not a wallet holding funds.</strong> The command signs wallet-auth messages, submits your host details, then supplies the sidecar credential to the router. It sends no transactions. <code>--dry-run</code> prints canonical signup and credential bodies without reading keys or sending requests; api_key is shown as &lt;redacted&gt; and the signup-assigned provider id as &lt;provider_id&gt;. <code>--status PROVIDER_ID</code> polls status five times; <code>--help</code> lists options.</p>
    <p>Omit the API key source to register first, then use <code>node join.mjs --credential-only PROVIDER_ID --key-file /path/to/operator.key --api-key-file /path/to/sidecar.key</code>. <code>--api-key-env NAME</code> selects an environment variable instead. The trimmed API key must contain 16–500 characters; POSIX files must not be group or world readable. The router stores the credential encrypted and can decrypt it to call your sidecar.</p>
    <dl className={s.digest}><dt>join.mjs SHA-256</dt><dd><code data-network-join-sha256={sha}>{sha}</code></dd></dl>
    <p>Your signup details go to the router, including your operator wallet, endpoint, payout address, model ids and any contact you supply. Anyroute’s router still reads inference requests in memory.</p>
  </section>;
}
