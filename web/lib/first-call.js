// ON2: progress comes from authenticated reads, never from estimated spending.
export function firstCallSteps(snapshot = {}) {
  const signedIn = !!snapshot.me?.hash;
  const balance = Number(snapshot.credits?.balance);
  return [
    { id: 'key', title: 'Get a key', text: 'Sign in with your wallet to get an API key.', href: '/dashboard/', done: signedIn },
    { id: 'funds', title: 'Add funds', text: 'Open Payments and deposit a listed token.', href: '/dashboard/#payments', done: signedIn && Number.isFinite(balance) && balance > 0, unknown: signedIn && !snapshot.credits },
    { id: 'call', title: 'Make your first call', text: 'Send a POST request with your key and a model.', href: '/docs/#quickstart', done: signedIn && snapshot.receipts?.length > 0, unknown: signedIn && !Array.isArray(snapshot.receipts) },
  ];
}
export function firstCallCurl({ account = false, apiKey = '', baseUrl = 'https://anyroute.tech' } = {}) {
  // Public examples always keep the shell variable, even if a caller supplies a key.
  const credential = account && apiKey ? apiKey : '$ANYROUTE_API_KEY';
  return `curl "${baseUrl}/api/v1/chat/completions" \\\n  -H "Authorization: Bearer ${credential}" -H "Content-Type: application/json" \\\n  -d '{"model":"meta-llama/llama-3.3-70b-instruct","messages":[{"role":"user","content":"Hello"}],"max_tokens":32}'`;
}
export async function readFirstCall(key, request, signal) {
  const paths = ['/api/v1/key', '/api/v1/credits', '/api/v1/generations?limit=1'];
  const names = ['me', 'credits', 'receipts'];
  const results = await Promise.allSettled(paths.map(path => request(path, { key, signal })));
  const snapshot = {};
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value?.data != null) snapshot[names[i]] = result.value.data;
    else snapshot[names[i] + 'Error'] = 'Account details could not be read. Refresh to try again.';
  });
  return snapshot;
}
