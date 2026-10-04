import { useEffect } from "react";

/** Keep the open picker aligned with account capacity; hidden tabs refresh when revisited. */
export function useCatalogRefresh(load) {
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") load(); };
    const interval = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
}
