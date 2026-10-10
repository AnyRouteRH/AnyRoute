import { and, eq, or, sql, inArray, isNull, isNotNull, ne } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { accounts, escrowDeposits, teams } from "../db/schema.ts";
import { fail } from "../lib/errors.ts";
import { accountLinkedWallets } from "./schema.ts";

export const walletAccount = (wallet: string) => `w_${wallet.toLowerCase().slice(2)}`;
// All link changes, wallet sign-ins and first deposit credits serialize on the same wallet across replicas.
export async function lockWallet(tx: Tx, wallet: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${wallet.toLowerCase()}, 154))`);
}
export async function secondaryWallets(db: Db | Tx, accountId: string) {
  return db.select().from(accountLinkedWallets).where(eq(accountLinkedWallets.accountId, accountId)).orderBy(accountLinkedWallets.linkedAt, accountLinkedWallets.wallet);
}
export async function assertWalletAvailable(tx: Tx, wallet: string, accountId: string) {
  await lockWallet(tx, wallet);
  const [account] = await tx.select({ id: accounts.id }).from(accounts).where(or(eq(accounts.wallet, wallet), eq(accounts.id, walletAccount(wallet))));
  if (account) fail(409, "This wallet already has its own account. Accounts cannot be merged.", "wallet_has_account");
  const [link] = await tx.select().from(accountLinkedWallets).where(eq(accountLinkedWallets.wallet, wallet));
  if (link) fail(409, "This wallet is already linked to an account. Unlink it there first.", "wallet_already_linked");
  const [organisation] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.ownerAddress, wallet), isNotNull(teams.ownerVerifiedAt), ne(teams.ownerAccount, accountId))).limit(1);
  if (organisation) fail(409, "This wallet is already verified for an organisation owned by another account. Use that account instead.", "wallet_already_linked");
}
export async function assertWalletSignIn(tx: Tx, wallet: string) {
  await lockWallet(tx, wallet);
  const [link] = await tx.select().from(accountLinkedWallets).where(eq(accountLinkedWallets.wallet, wallet.toLowerCase()));
  if (link) fail(409, "This wallet is linked to another account. Sign in with that account’s original wallet, or unlink it there first.", "wallet_already_linked");
}
export async function depositAccount(tx: Tx, wallet: string) {
  await lockWallet(tx, wallet);
  const [link] = await tx.select().from(accountLinkedWallets).where(eq(accountLinkedWallets.wallet, wallet.toLowerCase()));
  return link?.accountId ?? walletAccount(wallet);
}
export async function unlinkWallet(tx: Tx, accountId: string, wallet: string) {
  await lockWallet(tx, wallet);
  const removed = await tx.delete(accountLinkedWallets).where(and(eq(accountLinkedWallets.accountId, accountId), eq(accountLinkedWallets.wallet, wallet))).returning();
  if (!removed.length) fail(404, "Linked wallet not found.", "not_found");
}

// Credited history stays with the credited account; uncredited deposits follow the current sender link.
export async function accountDepositFilter(db: Db | Tx, accountId: string) {
  const wallets = (await secondaryWallets(db, accountId)).map(w => w.wallet);
  if (accountId.startsWith("w_")) wallets.push(`0x${accountId.slice(2)}`);
  return or(eq(escrowDeposits.accountId, accountId), wallets.length ? and(isNull(escrowDeposits.accountId), inArray(escrowDeposits.fromAddress, wallets)) : undefined)!;
}
