export const shortWallet = address => `${address.slice(0, 6)}…${address.slice(-4)}`;
export async function linkWallet(request, provider, key) {
  if (!provider) throw new Error('Open this page in a browser with a wallet.');
  const [address] = await provider.request({ method: 'eth_requestAccounts' });
  if (!address) throw new Error('Choose the wallet you want to link.');
  const { data: challenge } = await request('/api/v1/account/wallets/challenge', { key, method: 'POST', body: { address } });
  // Sign the server's exact message with the chosen secondary wallet. No transaction or funds move.
  const hex = '0x' + Array.from(new TextEncoder().encode(challenge.message), b => b.toString(16).padStart(2, '0')).join('');
  const signature = await provider.request({ method: 'personal_sign', params: [hex, address] });
  return request('/api/v1/account/wallets', { key, method: 'POST', body: { nonce: challenge.nonce, signature } });
}
export const unlinkWallet = (request, key, address) => request(`/api/v1/account/wallets/${address}`, { key, method: 'DELETE', body: { confirm: true } });
