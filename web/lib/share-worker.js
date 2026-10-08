// D137: serialized into sw.js. No runtime imports, persistent storage or inference calls.
export function createShareWorker({ cacheName }, env, parseDraft) {
  const origin = env.location.origin;
  const drafts = new Map();
  const ttl = 5 * 60 * 1000;
  const prune = () => { for (const [id, draft] of drafts) if (draft.expires <= Date.now()) drafts.delete(id); };
  const redirect = query => new Response(null, { status: 303, headers: { location: origin + '/harness/?' + query, 'cache-control': 'no-store' } });
  env.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== origin || url.pathname !== '/harness/') return;
    if (request.method === 'GET' && request.mode === 'navigate' &&
        ['share_title', 'share_text', 'share_url', 'share_id', 'share_error'].some(key => url.searchParams.has(key)) &&
        !request.headers.has('authorization') && !request.headers.has('range')) {
      // Return only the existing static shell. Never cache or forward the shared query.
      event.respondWith((async () => await (await env.caches.open(cacheName)).match(origin + '/harness/') ||
        env.fetch(new Request(origin + '/harness/', { credentials: 'omit' })))());
      return;
    }
    if (request.method !== 'POST' || url.searchParams.get('share_target') !== '1') return;
    event.respondWith((async () => {
      prune();
      if (!/^multipart\/form-data\s*;/i.test(request.headers.get('content-type') || '')) return redirect('share_error=invalid');
      // Bound the entire multipart body, including fields and framing, before formData allocates it.
      const limit = 6 * 8 * 1024 * 1024 + 64 * 1024;
      if (Number(request.headers.get('content-length')) > limit) return redirect('share_error=size');
      try {
        const reader = request.body?.getReader();
        if (!reader) return redirect('share_error=invalid');
        const chunks = [];
        let total = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > limit) { await reader.cancel(); return redirect('share_error=size'); }
          chunks.push(value);
        }
        const form = await new Response(new Blob(chunks), { headers: { 'content-type': request.headers.get('content-type') } }).formData();
        const parsed = parseDraft(form);
        const files = form.getAll('share_files');
        if (files.length > 6 || files.some(file => typeof file === 'string' || !file.size || file.size > 8 * 1024 * 1024 ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) return redirect('share_error=images');
        if (!parsed.text && !files.length) return redirect('share_error=empty');
        // At most two pending shares; originals live only in worker memory until consumed/evicted.
        while (drafts.size >= 2) drafts.delete(drafts.keys().next().value);
        const id = env.crypto.randomUUID();
        drafts.set(id, { text: parsed.text, truncated: parsed.truncated, files, expires: Date.now() + ttl });
        return redirect('share_id=' + id);
      } catch { return redirect('share_error=invalid'); }
    })());
  });
  env.addEventListener('message', event => {
    if (event.data?.type !== 'anyroute-share-consume' || !event.ports?.[0]) return;
    let url;
    try { url = new URL(event.source.url); } catch { return; }
    if (url.origin !== origin || url.pathname !== '/harness/') return;
    prune();
    const draft = drafts.get(event.data.id);
    drafts.delete(event.data.id); // Single use, including simultaneous tabs.
    event.ports[0].postMessage({ draft: draft ? { text: draft.text, truncated: draft.truncated, files: draft.files } : null });
  });
}
