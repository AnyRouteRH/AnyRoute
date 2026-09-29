// Minimal EIP-1193 wallet helpers (MetaMask, Rabby, Coinbase Wallet, etc.). The router never holds a
// user's funds: it returns unsigned transactions and the user's wallet signs and sends them.
import { api } from "./api.js";

const provider = () => (typeof window !== "undefined" ? window.ethereum : undefined);
export const hasWallet = () => !!provider();

export async function connect() {
  const eth = provider();
  if (!eth) throw new Error("No browser wallet found. Install a wallet such as MetaMask, or use the manual deposit details.");
  const [address] = await eth.request({ method: "eth_requestAccounts" });
  if (!address) throw new Error("The wallet did not share an account.");
  return address;
}

/** Switch the wallet to the router's chain, adding it first if the wallet does not know it. */
export async function ensureChain({ id, name, rpc, explorer }) {
  const eth = provider();
  const hex = "0x" + Number(id).toString(16);
  if ((await eth.request({ method: "eth_chainId" })) === hex) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String(e?.message))) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hex, chainName: name || "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [rpc], ...(explorer ? { blockExplorerUrls: [explorer] } : {}) }],
    });
  }
}

async function waitForReceipt(hash, timeoutMs = 180_000) {
  const eth = provider();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await eth.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (r) {
      if (r.status !== "0x1") throw new Error("The transaction failed on-chain: " + hash);
      return r;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The transaction was not confirmed in time: " + hash);
}

/** Send the router's unsigned transactions in order, waiting for each to confirm. */
export async function sendTransactions(from, txs, onStep) {
  const eth = provider();
  const hashes = [];
  for (const [i, tx] of txs.entries()) {
    onStep?.(`${i + 1}/${txs.length}: ${tx.description || "Confirm in your wallet"}`);
    const hash = await eth.request({ method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: "0x0" }] });
    onStep?.(`${i + 1}/${txs.length}: waiting for confirmation…`);
    await waitForReceipt(hash);
    hashes.push(hash);
  }
  return hashes;
}

/** EIP-712 signature (eth_signTypedData_v4) over typed data the router prepared; the wallet shows every field. */
export async function signTypedData(address, typedData) {
  return provider().request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(typedData)] });
}

export async function personalSign(address, message) {
  const hex = "0x" + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("");
  return provider().request({ method: "personal_sign", params: [hex, address] });
}

/** The account the wallet has already shared with this site, or null (never prompts). */
export async function connectedAccount() {
  try {
    const [address] = (await provider()?.request({ method: "eth_accounts" })) ?? [];
    return address || null;
  } catch {
    return null;
  }
}

/** A wallet's balance of an ERC-20 token (raw units), read through the wallet's own connection. Null when it cannot be read. */
export async function tokenBalance(owner, token) {
  try {
    const data = "0x70a08231" + owner.slice(2).toLowerCase().padStart(64, "0");
    const r = await provider().request({ method: "eth_call", params: [{ to: token, data }, "latest"] });
    return /^0x[0-9a-fA-F]+$/.test(r) ? BigInt(r) : null;
  } catch {
    return null;
  }
}

export const shortAddress = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

/** Wallet sign-in: sign the router's one-time challenge and receive this wallet's API key. No password, no email. */
export async function walletApiKey(name = "Wallet key") {
  const address = await connect();
  const { data: challenge } = await api("/api/v1/auth/wallet/challenge", { method: "POST", body: { address } });
  const signature = await personalSign(address, challenge.message);
  const r = await api("/api/v1/auth/wallet", { method: "POST", body: { address, nonce: challenge.nonce, signature, name } });
  return r.key;
}
