import type { ExternalDoc } from "./types";
// G156: extends the existing encrypted browser history, with no server storage.
export const chatBranchesBrowser: ExternalDoc["browser"]["items"][number] = {
  store: "IndexedDB (existing encrypted Chat history vault)",
  holds: "Optional lane branches metadata keeps message versions as parent-linked nodes and selected message ids in the existing passphrase-encrypted anyroute-private-history vault. Each node keeps user or assistant text, ids, file names, prepared input images, supported generated image links or bytes, image mode, model/provider, reported token counts and cost, latency, receipt id/lane/disclosure, reply status and errors, and tool call ids/names/arguments or tool result text. Document contents, audio and reasoning are not saved. Decrypted versions and unsaved attachments live in page memory; locking drops the vault key and decrypted history, while a conversation already on screen remains in page memory. Forget deletes the vault. Branches share the existing chat size limit, folders and saved answers; no browser storage key, server table, column, Redis family, log field or server reader is added. JSON downloads expose all versions as readable data; imports validate the optional fields and older clients can ignore them. Markdown shows the selected version. Only the selected path is sent for inference and counted in the displayed context and chat cost; earlier versions were billed when requested and switching does not refund them. The router reads ordinary inference requests in memory. Switching versions sends nothing to the router.",
  evidence: [
    { file: "web/lib/harness-branches.js", contains: "export function forkLane" },
    { file: "web/lib/harness-branch-history.js", contains: "export function validateBranches" },
    { file: "web/lib/harness-image-history.js", contains: "snapshotBranches(lanes[index]" },
    { file: "web/components/harness/Branches.jsx", contains: "export function BranchVersions" },
  ],
};
