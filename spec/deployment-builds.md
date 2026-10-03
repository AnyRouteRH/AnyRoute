# Deployment build proof

[Historical app-contract record](../deployments/historical-app-contracts.json) preserves the audit's read-only block snapshot, source revision, compiler settings, source hashes and source/runtime comparison results. It is historical partial evidence with immutable offsets masked, and cannot be consumed as a new production build proof.

| Published contract | Verified source |
|---|---|
| AgreementEscrow | [Sourcify compilation record](https://sourcify.dev/server/v2/contract/4663/0xefd8d05f45b8a92aa3b3ef3a7db4c9d3a21f7c96?fields=compilation) |
| DisputeOracle | [Sourcify compilation record](https://sourcify.dev/server/v2/contract/4663/0xcdeddcea1e039e72868bb8af3206af2647afda5a?fields=compilation) |
| HostBond | [Sourcify compilation record](https://sourcify.dev/server/v2/contract/4663/0x2921d34fd86d3323a5369a270a82814a74250518?fields=compilation) |

The main deployment verifier now requires source equivalence. A missing build record, changed executable byte, changed immutable, source/dependency input mismatch or wrong revision fails. Metadata normalization is limited to the terminal Solidity CBOR trailer. External infrastructure requires an independently reviewed full runtime hash; do not copy live code hashes into expected values merely to obtain a pass.

After the candidate is reviewed and committed, prepare a public `reviewed-runtime-inputs.json` keyed by deployment-manifest contract names. Each compiled entry supplies an artifact under contracts/out/ and immutableValues keyed by compiler AST IDs, with exact byte lengths. Derive values from reviewed constructor arguments and artifact immutable references. External entries contain externalHash. Include every manifest contract, including tokens and infrastructure.

```sh
bun scripts/record-deployment-build.ts reviewed-runtime-inputs.json > deployments/reviewed-build.json
bun scripts/verify-deployment.ts deployments/production.json --rpc-url https://public-rpc.example --build-record deployments/reviewed-build.json > release-evidence/deployment-verifier.json
```

The recorder force-compiles the clean tree and binds every compiler source plus Foundry settings, root lockfile and artifact SHA-256. Review and preserve the output with the matching compiler artifacts. The verifier performs read-only RPC calls at one block snapshot. A production startup also requires a passing source-equivalence check tied to the report revision; old presence-only reports are rejected.

This does not prove image provenance, TEE/KMS policy, or addresses omitted from the manifest. The separate app-only deployment still needs a fresh immutable/configuration/governance manifest. No production verification, ownership transfer, signing or broadcasting is performed by these documentation steps.
