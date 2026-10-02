// V82: reply content stays in the browser; no persistence or network calls.
const EXTENSIONS = Object.freeze({
  html: 'html', svg: 'svg', markdown: 'md', md: 'md',
  javascript: 'js', js: 'js', jsx: 'jsx', mjs: 'mjs', cjs: 'cjs',
  typescript: 'ts', ts: 'ts', tsx: 'tsx', json: 'json', css: 'css',
  python: 'py', py: 'py', bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'zsh',
  yaml: 'yaml', yml: 'yml', toml: 'toml', xml: 'xml', sql: 'sql',
  rust: 'rs', rs: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'cpp',
  'c++': 'cpp', 'c#': 'cs', csharp: 'cs', ruby: 'rb', rb: 'rb',
  php: 'php', swift: 'swift', kotlin: 'kt', solidity: 'sol', text: 'txt', txt: 'txt',
});

export const codeLanguage = (lang) => String(lang || '').trim().toLowerCase();
export const codeFilename = (lang) => `reply.${EXTENSIONS[codeLanguage(lang)] || 'txt'}`;
export function previewType(lang) {
  const type = codeLanguage(lang);
  return type === 'md' || type === 'markdown' ? 'markdown' : ['html', 'svg'].includes(type) ? type : null;
}

export const escapeAttribute = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const svgImage = (text) => `<img alt="SVG preview" src="data:image/svg+xml,${encodeURIComponent(text)}">`;

export function previewPolicy(lang, runScripts = false) {
  const scripts = previewType(lang) === 'html' && runScripts === true;
  return {
    sandbox: scripts ? 'allow-scripts' : '',
    csp: `default-src 'none'; img-src data:; style-src 'unsafe-inline';${scripts ? " script-src 'unsafe-inline';" : ''} base-uri 'none'; form-action 'none';`,
  };
}

// Only system fonts: the preview never loads the site's font files or other assets.
const PREVIEW_STYLE = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;padding:16px;background:#f5f5f0;color:#0b0c0b;font:15.5px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}p,ul,ol,blockquote,pre,table{margin:0 0 .85em}h1,h2,h3,h4,h5,h6{margin:1.3em 0 .5em;line-height:1.2;letter-spacing:-.02em}h3{font-size:20px}h4{font-size:17px}h5,h6{font-size:15.5px}a{color:inherit;text-decoration-color:#0a7d31}blockquote{padding:10px 14px;background:#ecece5;color:#5b605a}code,pre{font-family:ui-monospace,monospace}pre{padding:14px;overflow:auto;background:#0b0c0b;color:#f5f5f0;font-size:12.5px}table{border-collapse:collapse;width:100%}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #ecece5}button{display:none}`;
const documentFor = (body, csp, style) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>${style}</style></head><body>${body}</body></html>`;

/** Markdown input here must be markup rendered by the existing Markdown component. */
export function previewDocument(lang, text, runScripts = false, markdownMarkup = '') {
  const type = previewType(lang);
  if (!type) throw new TypeError('This language has no preview');
  const policy = previewPolicy(lang, runScripts);
  const body = type === 'svg' ? svgImage(text) : type === 'markdown' ? markdownMarkup : String(text);
  const inner = documentFor(body, policy.csp, PREVIEW_STYLE);
  // The trusted outer document owns the inner frame. Its default-src 'none'
  // also blocks remote frame navigations; the untrusted document cannot remove
  // that policy. A single sandbox frame's CSP does not block its own navigation.
  const frame = `<iframe title="${type} content" sandbox="${policy.sandbox}" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(inner)}"></iframe>`;
  return { ...policy, srcDoc: documentFor(frame, policy.csp, 'html,body{height:100%;margin:0}iframe{display:block;width:100%;height:100%;border:0}') };
}

export function downloadCode(text, lang) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = codeFilename(lang);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
