// Read a copy so callers can still inspect scope errors and settlement responses.
export async function checkNativeQuote(response) {
  if (response.status !== 409) return;
  const body = await response.clone().json().catch(() => null);
  if (body?.error_code === 'native_quote_expired') {
    throw new Error('The Sepolia ETH price is refreshing. Try again in a few minutes.');
  }
}
