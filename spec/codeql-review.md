# Automated analysis review

The private-source CodeQL run for `5db514a9db30755dc694b101198d3d9ba9abf1ff` completed JavaScript/TypeScript, Python and Go analyses. Python and Go reported no findings. JavaScript reported 18 candidate findings. A successful workflow does not mean a clean security review. SARIF is retained as a workflow artifact; the public mirror also uploads results to GitHub Code Scanning.

| Finding group | Disposition |
|---|---|
| Bearer-header regular expression (1) | Replaced overlapping whitespace matching with disjoint token matching; valid tab-separated credentials and whitespace-only rejection are covered by the proxy regression. |
| Static CSP script extraction (1) | Closing-tag whitespace is handled and tested. Input is trusted static build output; this hash collector is not an HTML sanitizer. Unusual HTML still needs parser-level review if untrusted HTML becomes supported. |
| Predictable heartbeat temporary file (1) | Publication uses a fresh private directory, exclusive creation and atomic rename. A regression plants both the old temporary symlink and a target symlink and verifies that their victim is unchanged. |
| Attestation failure-code regex (1) | All three alternative prefixes are grouped under the same start anchor; their classification is covered by regression cases. This classifier reports fixed diagnostic codes, not quote acceptance. |
| Certificate validation disabled (1) | The flagged connection only reads a certificate and closes without sending application data. The provider attestor independently binds that certificate to verified hardware evidence. Preserve this distinction during independent TLS/attestation review. |
| SHA-256 password heuristics (3) | Two paths hash API-token inputs, rather than storing human account passwords; the network-join path signs a protocol-defined request-body digest. Review token generation and local-key policy independently; do not change the wallet authentication protocol to satisfy a heuristic. |
| File-system race heuristics (6) | Deployment, local launch, static preview, publication and sidecar initialization operate on local operator files. Measurement publication and initial key creation use exclusive writes. Independent review must confirm directory ownership, concurrent-launch behavior, forced writes and static deployment assumptions. These are not blanket accepted risks. |
| File-to-HTTP flows (3) | Attestation verification, local launch RPC and explicit sidecar application submission consume operator-selected configuration. Independent review must confirm destination controls and the distinction between client tooling and server-side untrusted URL handling. |
| HTTP-to-file flow (1) | Sidecar application submission saves the returned application token to a fixed local filename with restricted permissions. Independent review must confirm the selected directory and failure handling. |

This is a bounded implementation review, not the missing independent audit or an accepted-finding register. Consult the final candidate's SARIF for the remaining findings; counts above describe the named input revision.
