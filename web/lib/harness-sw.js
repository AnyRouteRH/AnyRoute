// Exact build-owned paths only. Runtime requests never populate Cache Storage.
export function shellRoute(request, origin, assets) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== origin || url.search || url.username || url.password) return null;
  if (request.headers.has('authorization') || request.headers.has('range')) return null;
  // Keep API navigations network-only too, even if a future build lists one by mistake.
  let pathname;
  try { pathname = decodeURIComponent(url.pathname).toLowerCase(); } catch { return null; }
  if (/^\/(api|trpc|v1)(\/|$)/.test(pathname)) return null;
  return Object.hasOwn(assets, url.pathname) ? url.pathname : null;
}

export function createShellWorker({ assets, cacheName }, env) {
  const origin = env.location.origin;
  const prefix = 'anyroute-shell-';
  env.addEventListener('install', event => event.waitUntil((async () => {
    const cache = await env.caches.open(cacheName);
    try {
      for (const [pathname, expected] of Object.entries(assets)) {
        const request = new Request(new URL(pathname, origin), { credentials: 'omit', cache: 'no-store' });
        if (!shellRoute(request, origin, assets)) throw new Error('Invalid shell path');
        const response = await env.fetch(request);
        if (response.status !== 200 || response.redirected || response.type === 'opaque' ||
            /\b(private|no-store)\b/i.test(response.headers.get('cache-control') || '')) throw new Error('Invalid shell response');
        const bytes = await response.clone().arrayBuffer();
        const digest = await env.crypto.subtle.digest('SHA-256', bytes);
        const actual = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        if (actual !== expected) throw new Error('Shell content changed');
        await cache.put(request, response);
      }
    } catch (error) {
      await env.caches.delete(cacheName);
      throw error;
    }
  })()));
  // No skipWaiting: existing tabs keep their matching shell until they close.
  env.addEventListener('activate', event => event.waitUntil((async () => {
    for (const name of await env.caches.keys()) {
      if (name.startsWith(prefix) && name !== cacheName) await env.caches.delete(name);
    }
    await env.clients.claim();
  })()));
  env.addEventListener('fetch', event => {
    const pathname = shellRoute(event.request, origin, assets);
    if (!pathname) return; // Browser networking handles every other request, with no offline substitution.
    event.respondWith((async () => {
      const cached = async path => (await env.caches.open(cacheName)).match(new URL(path, origin).href);
      if (event.request.mode === 'navigate') {
        const shell = await cached(pathname);
        if (shell) return shell;
        try { return await env.fetch(event.request); }
        catch { return await cached('/offline.html') || Response.error(); }
      }
      return await cached(pathname) || env.fetch(event.request);
    })());
  });
}
