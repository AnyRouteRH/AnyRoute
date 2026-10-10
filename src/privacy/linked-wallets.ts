import type { ExternalDoc, TableDoc, RedisFamily } from "./types.ts";
export function describeLinkedWallets(docs: Record<string, TableDoc>) {
  docs.account_linked_wallets = {
    category: "keys", request: "no", purpose: "Signature-verified secondary wallets associated with an account for escrow deposit crediting and paying another agent.",
    retention: "Until the owner unlinks the wallet; unlink deletes this association. Existing deposit, ledger and payment records remain under their original account.",
    notes: ["Wallet addresses are public chain identifiers that can correlate this account with its deposits and agent payments. Linking does not merge accounts or let the secondary wallet sign in to the owner account."],
    columns: { wallet: "Lowercase secondary wallet address verified by a personal signature, unique across accounts.", account_id: "Owning account whose owner requested and verified the link.", linked_at: "When verification linked the wallet to the account." },
  };
  docs.kv.notes?.push("wallet-link:<random nonce> holds the owner account id, secondary wallet, origin, chain id, five-minute expiry and exact link message. Signatures are checked in memory and not retained. Successful linking consumes the row atomically. Expired rows are removed on later challenge requests once ten minutes old; without later requests they remain until removed.");
}
export const linkedWalletReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/api/linked-wallets.ts", carries: "settings", reads: "A secondary wallet address, or a one-time nonce and personal signature, or explicit unlink confirmation.",
  then: "Requires an account owner key. Verifies the configured origin, chain id, five-minute expiry and secondary wallet signature; consumes the nonce once. Refuses existing wallet accounts, other secondary links and verified owner wallets of organisations owned by other accounts. Unlink affects later first deposit credits and agent payment eligibility; earlier credits remain assigned.",
  kept: "The link address, account id and linked date in account_linked_wallets; challenge metadata in kv; no signature, prompt, answer, caller network address or new log field.",
  evidence: [{ file: "src/api/linked-wallets.ts", contains: 'signature: z.string().regex' }],
};
export const linkedWalletRate: RedisFamily = {
  key: "rl:wallet-link:<account id>:<window start>", purpose: "Limits wallet link challenges to thirty per account per minute.", holds: "account", limiterPrefix: "wallet-link:", windowSeconds: 60, ttl: "61 seconds (the 60-second window plus one second)",
  evidence: [{ file: "src/api/linked-wallets.ts", contains: 'ctx.limiter.take(`wallet-link:${key.accountId}`' }],
};
