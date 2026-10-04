import type { ExternalDoc } from "./types.ts";
export const depositProgressReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/deposits.ts", carries: "settings",
  reads: "A strict transaction hash and deposit lane only. Form amounts and sender addresses are not accepted.",
  then: "Authenticates the key, excludes session and agent-only roles, scopes reads and submitted hashes to its account. Chain logs determine observed amounts, senders and credit values; submission never credits funds.",
  kept: "deposit-watch rows in kv keep account id, lane, hash and submission time across reloads. At most 20 submitted hashes per account; removed after final indexed detection, otherwise retained until operator deletion. No new Redis keys, caller-address readers or log fields.",
  evidence: [{ file: "src/api/deposits.ts", contains: "watchBody.parse(await readJson(c))" }],
};
