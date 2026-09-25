// Minimal EIP-1193 wallet helpers (MetaMask, Rabby, Coinbase Wallet, etc.). The router never holds a
// user's funds: it returns unsigned transactions and the user's wallet signs and sends them.

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

export async function personalSign(address, message) {
  const hex = "0x" + Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("");
  return provider().request({ method: "personal_sign", params: [hex, address] });
}

export const shortAddress = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
