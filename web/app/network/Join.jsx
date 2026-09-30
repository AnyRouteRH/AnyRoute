"use client";
import { useEffect, useState } from "react";
import { hostsOpen } from "../../lib/network-hosts";
import s from "./network.module.css";

export default function Join({ sha }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { let active = true; hostsOpen().then((value) => { if (active) setOpen(value); }); return () => { active = false; }; }, []);
  return <section id="join"><span className="eyebrow">HOST REGISTRATION</span><h2>When hosting opens</h2>
    <p role="status"><strong>{open ? "Host registration is open." : "Hosting isn’t open yet."}</strong> {open ? "Admission requires fresh hardware attestation and the published host policy." : "These commands are for when host registration opens; they do not admit a host while registration is closed."}</p>
    <p>First inspect <code>deploy/seal/install.sh</code> in a repository checkout, then run it with your host configuration. Its <code>--help</code> lists hardware and image requirements; Docker Compose and an already running model engine are required to start the sidecar.</p>
    <pre className={s.code}><code>{'sh deploy/seal/install.sh --hf-repo HF_REPO --weights-sha256 sha256:WEIGHTS_DIGEST --price-in INPUT_PRICE --price-out OUTPUT_PRICE --region REGION --sidecar-image IMAGE_DIGEST --apply'}</code></pre>
    <p>Then download <a href="/network/join.mjs">join.mjs</a>, compare its SHA-256 below and inspect it before running. Requires Node 22 or later. Replace the capitalized values with your host settings and model ids. Keep the operator private key in a file readable only by you.</p>
    <pre className={s.code}><code>{'node join.mjs --key-file /path/to/operator.key --name HOST_NAME --endpoint https://SIDECAR --payout-address 0xPAYOUT_ADDRESS --models MODEL_ID'}</code></pre>
    <p><strong>Use a dedicated operator wallet, not a wallet holding funds.</strong> The command signs a wallet-auth message and submits your host details. It sends no transactions. <code>--dry-run</code> prints the exact signup body without reading a key or sending it. <code>--status PROVIDER_ID</code> polls status five times; <code>--help</code> lists options.</p>
    <dl className={s.digest}><dt>join.mjs SHA-256</dt><dd><code data-network-join-sha256={sha}>{sha}</code></dd></dl>
    <p>Your signup details go to the router, including your operator wallet, endpoint, payout address, model ids and any contact you supply. AnyRoute’s router still reads inference requests in memory.</p>
  </section>;
}
