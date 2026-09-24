// Live data adapter: the Anyroute API behind the existing interface.
// The site is normally served by the router itself (same origin). Set NEXT_PUBLIC_ANYROUTE_API_URL at
// build time to call a router hosted elsewhere. No secret is ever bundled: the API key is supplied by
// the user and kept in this browser only (session storage unless "remember" is chosen).

export const API_BASE = (process.env.NEXT_PUBLIC_ANYROUTE_API_URL || "").replace(/\/$/, "");
export const keyStore = "anyroute-key-v1";
export const modeStore = "anyroute-mode";

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

/** "demo" only when the visitor explicitly chose the sample workspace (or ?demo=1); otherwise live. */
export function getMode() {
  if (typeof window === "undefined") return "live";
  if (new URLSearchParams(window.location.search).get("demo") === "1") return "demo";
  return safe(() => localStorage.getItem(modeStore), null) === "demo" ? "demo" : "live";
}
export function setMode(mode) {
  safe(() => (mode === "demo" ? localStorage.setItem(modeStore, "demo") : localStorage.removeItem(modeStore)));
}

export function loadKey() {
  return safe(() => sessionStorage.getItem(keyStore) || localStorage.getItem(keyStore), null) || "";
}
export function saveKey(secret, remember) {
  safe(() => {
    sessionStorage.setItem(keyStore, secret);
    if (remember) localStorage.setItem(keyStore, secret);
    else localStorage.removeItem(keyStore);
  });
}
export function clearKey() {
  safe(() => {
    sessionStorage.removeItem(keyStore);
    localStorage.removeItem(keyStore);
  });
}
export const validKey = (s) => /^sk-ar-v1-[0-9a-f]{64}$/.test(String(s).trim());

export class ApiError extends Error {
  constructor(status, message, type, metadata) {
    super(message);
    this.status = status;
    this.type = type;
    this.metadata = metadata;
  }
}
