// D137: shared values remain plain composer text, never HTML or executable links.
export function parseSharedDraft(params) {
  const fields = [['share_title', 512], ['share_text', 16000], ['share_url', 2048]];
  let truncated = false;
  const parts = fields.map(([key, cap]) => {
    const raw = params.get(key);
    if (typeof raw !== 'string') return '';
    const clean = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (clean.length > cap) truncated = true;
    return clean.slice(0, cap).replace(/[\uD800-\uDBFF]$/, '');
  });
  const joined = parts.filter(Boolean).join('\n');
  if (joined.length > 16384) truncated = true;
  return { present: fields.some(([key]) => params.has(key)), text: joined.slice(0, 16384).replace(/[\uD800-\uDBFF]$/, ''), truncated };
}

export function sharedLocation(location) {
  const url = new URL(location.href);
  return { ...parseSharedDraft(url.searchParams), id: url.searchParams.get('share_id'), error: url.searchParams.has('share_error') };
}

export function clearSharedLocation(win) {
  const url = new URL(win.location.href);
  for (const key of ['share_title', 'share_text', 'share_url', 'share_id', 'share_error', 'share_target']) url.searchParams.delete(key);
  win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
}

// The worker can be stopped by the browser. A missing handoff is surfaced, never silently sent.
export function receiveSharedDraft(serviceWorker, id, Channel = MessageChannel) {
  return new Promise((resolve, reject) => {
    const channel = new Channel();
    let settled = false;
    const finish = (error, draft) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close(); channel.port2.close();
      error ? reject(error) : resolve(draft);
    };
    const timer = setTimeout(() => finish(new Error('Share unavailable')), 5000);
    channel.port1.onmessage = event => event.data?.draft ? finish(null, event.data.draft) : finish(new Error('Share unavailable'));
    serviceWorker.ready.then(registration => {
      if (settled) return;
      const worker = serviceWorker.controller || registration.active;
      if (!worker) return finish(new Error('Share unavailable'));
      worker.postMessage({ type: 'anyroute-share-consume', id }, [channel.port2]);
    }).catch(error => finish(error));
  });
}
