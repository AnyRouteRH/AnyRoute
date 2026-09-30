// The kit's stylesheet. Every rule is wrapped in :where(), so it has zero specificity and any rule of yours wins.
// Everything visual reads a CSS variable (--ark-*); set them on .ark-root, or pass `vars` to <AnyrouteChat>.
// Two themes ("neutral", "anyroute"), each in light and dark; data-scheme="auto" follows prefers-color-scheme.

export const THEME_VARS = [
  "--ark-bg",
  "--ark-fg",
  "--ark-muted",
  "--ark-surface",
  "--ark-surface-2",
  "--ark-user-bg",
  "--ark-user-fg",
  "--ark-accent",
  "--ark-accent-fg",
  "--ark-danger",
  "--ark-focus",
  "--ark-code-bg",
  "--ark-radius",
  "--ark-font",
  "--ark-mono",
  "--ark-font-size",
  "--ark-gap",
  "--ark-max-width",
] as const;

export type ThemeVar = (typeof THEME_VARS)[number];
export type ThemeName = "neutral" | "anyroute";
export type ColorScheme = "light" | "dark" | "auto";

type Palette = Record<ThemeVar, string>;

const shared = {
  "--ark-font-size": "15px",
  "--ark-gap": "12px",
  "--ark-max-width": "780px",
};

export const THEMES: Record<ThemeName, { light: Palette; dark: Palette }> = {
  neutral: {
    light: {
      ...shared,
      "--ark-bg": "#ffffff",
      "--ark-fg": "#18181b",
      "--ark-muted": "#62626b",
      "--ark-surface": "#f4f4f5",
      "--ark-surface-2": "#e7e7ea",
      "--ark-user-bg": "#18181b",
      "--ark-user-fg": "#fafafa",
      "--ark-accent": "#1d4ed8",
      "--ark-accent-fg": "#ffffff",
      "--ark-danger": "#b42318",
      "--ark-focus": "#1d4ed8",
      "--ark-code-bg": "#f4f4f5",
      "--ark-radius": "10px",
      "--ark-font": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      "--ark-mono": 'ui-monospace, "SFMono-Regular", Menlo, monospace',
    },
    dark: {
      ...shared,
      "--ark-bg": "#131316",
      "--ark-fg": "#ededf0",
      "--ark-muted": "#a1a1aa",
      "--ark-surface": "#1f1f24",
      "--ark-surface-2": "#2b2b31",
      "--ark-user-bg": "#ededf0",
      "--ark-user-fg": "#131316",
      "--ark-accent": "#8ab4ff",
      "--ark-accent-fg": "#0b0b0e",
      "--ark-danger": "#ff8a80",
      "--ark-focus": "#8ab4ff",
      "--ark-code-bg": "#1f1f24",
      "--ark-radius": "10px",
      "--ark-font": 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      "--ark-mono": 'ui-monospace, "SFMono-Regular", Menlo, monospace',
    },
  },
  anyroute: {
    light: {
      ...shared,
      "--ark-bg": "#f5f5f0",
      "--ark-fg": "#0b0c0b",
      "--ark-muted": "#5b605a",
      "--ark-surface": "#ecece5",
      "--ark-surface-2": "#e2e2d9",
      "--ark-user-bg": "#0b0c0b",
      "--ark-user-fg": "#f5f5f0",
      "--ark-accent": "#0a7d31",
      "--ark-accent-fg": "#ffffff",
      "--ark-danger": "#b4232a",
      "--ark-focus": "#0a7d31",
      "--ark-code-bg": "#e2e2d9",
      "--ark-radius": "2px",
      "--ark-font": '"Host Grotesk Variable", "Host Grotesk", ui-sans-serif, system-ui, sans-serif',
      "--ark-mono": '"Martian Mono Variable", "Martian Mono", ui-monospace, Menlo, monospace',
    },
    dark: {
      ...shared,
      "--ark-bg": "#0b0c0b",
      "--ark-fg": "#f5f5f0",
      "--ark-muted": "#979d96",
      "--ark-surface": "#131513",
      "--ark-surface-2": "#1d201d",
      "--ark-user-bg": "#2a2e2a",
      "--ark-user-fg": "#f5f5f0",
      "--ark-accent": "#1fe15a",
      "--ark-accent-fg": "#0b0c0b",
      "--ark-danger": "#ff6b6f",
      "--ark-focus": "#1fe15a",
      "--ark-code-bg": "#131513",
      "--ark-radius": "2px",
      "--ark-font": '"Host Grotesk Variable", "Host Grotesk", ui-sans-serif, system-ui, sans-serif',
      "--ark-mono": '"Martian Mono Variable", "Martian Mono", ui-monospace, Menlo, monospace',
    },
  },
};

const block = (sel: string, p: Palette) => `${sel}{${Object.entries(p).map(([k, v]) => `${k}:${v};`).join("")}}`;

function themeCss(): string {
  const out: string[] = [];
  for (const name of Object.keys(THEMES) as ThemeName[]) {
    const t = THEMES[name];
    const base = name === "neutral" ? ".ark-root" : `.ark-root[data-theme="${name}"]`;
    out.push(block(`:where(${base})`, t.light));
    out.push(block(`:where(${base}[data-scheme="dark"])`, t.dark));
    out.push(`@media (prefers-color-scheme: dark){${block(`:where(${base}[data-scheme="auto"])`, t.dark)}}`);
  }
  return out.join("\n");
}

const rules = `
:where(.ark-root){color-scheme:light dark;background:var(--ark-bg);color:var(--ark-fg);font-family:var(--ark-font);font-size:var(--ark-font-size);line-height:1.55;display:flex;flex-direction:column;min-height:0;height:100%;box-sizing:border-box}
:where(.ark-root *,.ark-root *::before,.ark-root *::after){box-sizing:inherit}
:where(.ark-root button,.ark-root select,.ark-root textarea,.ark-root input){font:inherit;color:inherit}
:where(.ark-root :focus-visible){outline:2px solid var(--ark-focus);outline-offset:2px}
:where(.ark-sr){position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
:where(.ark-header){display:flex;align-items:center;gap:var(--ark-gap);padding:calc(var(--ark-gap)*1.25) var(--ark-gap);background:var(--ark-surface)}
:where(.ark-title){margin:0;font-size:1em;font-weight:600;flex:1;min-width:0}
:where(.ark-picker){display:flex;align-items:center;gap:8px;color:var(--ark-muted);font-size:.9em}
:where(.ark-picker select){background:var(--ark-bg);border:0;border-radius:var(--ark-radius);padding:6px 8px;max-width:22em}
:where(.ark-log){flex:1;overflow-y:auto;padding:var(--ark-gap);display:flex;flex-direction:column;gap:calc(var(--ark-gap)*1.5)}
:where(.ark-log > *){width:100%;max-width:var(--ark-max-width);margin-inline:auto}
:where(.ark-empty){color:var(--ark-muted);text-align:center;margin:auto}
:where(.ark-msg){display:flex;flex-direction:column;gap:6px}
:where(.ark-msg[data-role="user"]){align-items:flex-end}
:where(.ark-msg[data-role="user"] .ark-bubble){background:var(--ark-user-bg);color:var(--ark-user-fg);padding:10px 14px;border-radius:var(--ark-radius);max-width:85%;white-space:pre-wrap;overflow-wrap:anywhere}
:where(.ark-msg[data-role="assistant"] .ark-bubble){overflow-wrap:anywhere}
:where(.ark-msg[data-status="error"] .ark-bubble){color:var(--ark-danger)}
:where(.ark-who){font-size:.8em;color:var(--ark-muted)}
:where(.ark-thumbs){display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}
:where(.ark-thumbs img){width:72px;height:72px;object-fit:cover;border-radius:var(--ark-radius);background:var(--ark-surface)}
:where(.ark-thumbs span){font-size:.8em;color:var(--ark-muted);background:var(--ark-surface);padding:2px 8px;border-radius:var(--ark-radius)}
:where(.ark-meta){display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:.8em;color:var(--ark-muted)}
:where(.ark-meta a){color:inherit}
:where(.ark-error){color:var(--ark-danger)}
:where(.ark-btn){background:var(--ark-surface);border:0;border-radius:var(--ark-radius);padding:6px 12px;cursor:pointer}
:where(.ark-btn:hover){background:var(--ark-surface-2)}
:where(.ark-btn:disabled){opacity:.5;cursor:not-allowed}
:where(.ark-btn-primary){background:var(--ark-accent);color:var(--ark-accent-fg)}
:where(.ark-btn-primary:hover){background:var(--ark-accent);filter:brightness(1.08)}
:where(.ark-link){background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font-size:inherit}
:where(.ark-composer){padding:var(--ark-gap);background:var(--ark-surface)}
:where(.ark-composer-inner){max-width:var(--ark-max-width);margin-inline:auto;display:flex;flex-direction:column;gap:8px}
:where(.ark-composer textarea){width:100%;min-height:3em;max-height:40vh;resize:vertical;background:var(--ark-bg);border:0;border-radius:var(--ark-radius);padding:10px 12px}
:where(.ark-actions){display:flex;align-items:center;gap:8px}
:where(.ark-actions .ark-spacer){flex:1}
:where(.ark-pending){display:flex;flex-wrap:wrap;gap:6px}
:where(.ark-pending button){font-size:.8em}
:where(.ark-md > :first-child){margin-top:0}
:where(.ark-md > :last-child){margin-bottom:0}
:where(.ark-md p,.ark-md ul,.ark-md ol,.ark-md blockquote){margin:.6em 0}
:where(.ark-md h3,.ark-md h4,.ark-md h5,.ark-md h6){margin:1em 0 .4em;font-size:1em}
:where(.ark-md code){font-family:var(--ark-mono);font-size:.88em;background:var(--ark-code-bg);padding:.1em .35em;border-radius:var(--ark-radius)}
:where(.ark-md blockquote){margin-inline:0;padding-inline-start:12px;color:var(--ark-muted);background:var(--ark-surface)}
:where(.ark-md a){color:var(--ark-accent)}
:where(.ark-md hr){border:0;height:1px;background:var(--ark-surface-2)}
:where(.ark-code){background:var(--ark-code-bg);border-radius:var(--ark-radius);margin:.7em 0;overflow:hidden}
:where(.ark-code-bar){display:flex;justify-content:space-between;align-items:center;padding:4px 8px 4px 12px;font-size:.78em;color:var(--ark-muted);background:var(--ark-surface-2)}
:where(.ark-code pre){margin:0;padding:12px;overflow-x:auto;font-family:var(--ark-mono);font-size:.85em;line-height:1.5}
:where(.ark-code pre code){background:none;padding:0}
:where(.ark-copy){background:none;border:0;cursor:pointer;color:inherit;padding:2px 6px;border-radius:var(--ark-radius)}
:where(.ark-copy:hover){background:var(--ark-surface)}
:where(.ark-table){overflow-x:auto}
:where(.ark-table table){border-collapse:collapse;font-size:.92em}
:where(.ark-table th,.ark-table td){padding:4px 10px;text-align:start}
:where(.ark-table thead){background:var(--ark-surface)}
:where(.ark-table tbody tr:nth-child(even)){background:var(--ark-surface)}
:where(.ark-privacy){font-size:.85em}
:where(.ark-privacy summary){cursor:pointer;color:var(--ark-muted)}
:where(.ark-privacy-body){margin-top:6px;padding:10px 12px;background:var(--ark-surface);border-radius:var(--ark-radius)}
:where(.ark-privacy dl){margin:0;display:grid;grid-template-columns:minmax(8em,auto) 1fr;gap:4px 12px}
:where(.ark-privacy dt){color:var(--ark-muted)}
:where(.ark-privacy dd){margin:0}
:where(.ark-privacy ul){margin:0 0 8px;padding-inline-start:18px}
:where(.ark-lane){display:inline-block;background:var(--ark-surface-2);padding:0 6px;border-radius:var(--ark-radius)}
:where(.ark-vault){display:flex;flex-direction:column;gap:8px;padding:var(--ark-gap);background:var(--ark-surface);font-size:.9em}
:where(.ark-vault input){background:var(--ark-bg);border:0;border-radius:var(--ark-radius);padding:6px 10px;min-width:0;flex:1}
:where(.ark-vault-row){display:flex;flex-wrap:wrap;align-items:center;gap:8px}
:where(.ark-vault ul){list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;max-height:14em;overflow-y:auto}
:where(.ark-vault li){display:flex;gap:8px;align-items:center}
:where(.ark-vault li > button:first-child){flex:1;text-align:start;background:none;border:0;padding:4px 6px;border-radius:var(--ark-radius);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:where(.ark-vault li > button:first-child:hover){background:var(--ark-surface-2)}
:where(.ark-key){font-family:var(--ark-mono);font-size:.85em;overflow-wrap:anywhere;background:var(--ark-bg);padding:6px 10px;border-radius:var(--ark-radius)}
@media (prefers-reduced-motion: reduce){:where(.ark-root *){animation:none!important;transition:none!important}}
`;

/** The whole stylesheet: themes plus layout. Also shipped as @anyroute/chat-kit/styles.css. */
export const CHAT_KIT_CSS = `${themeCss()}\n${rules.trim()}\n`;

export const STYLE_ELEMENT_ID = "anyroute-chat-kit-styles";

/** Add the stylesheet to a document once (what <AnyrouteChat> does unless `injectStyles={false}`). */
export function injectStyles(doc: Document | undefined = globalThis.document): void {
  if (!doc || doc.getElementById(STYLE_ELEMENT_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ELEMENT_ID;
  el.textContent = CHAT_KIT_CSS;
  doc.head.appendChild(el);
}
