export default function SealEncryptedChatDocs() {
  return <section id="encrypted-chat">
    <h3>Encrypted chat is switched on at anyroute.tech.</h3>
    <p>The dedicated <code>POST /api/v1/e2ee/chat/completions</code> adapter forwards content encrypted on the client to the Phala attested gateway enclave. A correctly encrypting client keeps message content out of the router. Encryption ends at that gateway, which forwards restored content to the serving workload over a separate confidential channel; this is not client encryption directly to a GPU.</p>
    <p>The SDK requires an attestation verifier supplied by the caller and verifies the encrypted reply and gateway receipt, with no plaintext fallback. The router still sees model, roles, message counts and sizes, timing, usage and authorization metadata. Ordinary chat reads request text in router memory on every lane. This adapter supports the attested lane and Tor with blind tokens on the unlinkable lane; it does not make every router endpoint encrypted or carry sidecar <code>anyroute-hpke/v1</code> through the router. <a href="/docs/#e2ee-phala">Read the encrypted-chat checks and limits</a>.</p>
  </section>;
}
