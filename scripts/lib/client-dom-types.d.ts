// The client SDK (packages/client) is written against a DOM lib; this repository builds with the runtime's types only.
// scripts/seal-cli.ts imports the SDK's attestation checks, and this is the one name they use that the runtime types
// do not declare globally. (sidecar/src/onboard-client-types.d.ts does the same for the sidecar's onboarding CLI.)
type BufferSource = NodeJS.BufferSource;
