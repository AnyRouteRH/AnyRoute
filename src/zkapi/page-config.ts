import { z } from "zod";

// Limit CSP sources to HTTPS authorities, including optional ports and IPv6.
// URL parsing alone also accepts characters that delimit CSP directives.
function exactHttpsOrigin(value: string): boolean {
  if (!/^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[A-Fa-f0-9:.]+\])(?::[0-9]{1,5})?$/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const origins = (value: string) => value.split(",").map((origin) => origin.trim());
export const zkapiPageEnv = {
  ZKAPI_PAGE_ORIGINS: z.string().default("")
    .refine((value) => value === "" || origins(value).every(exactHttpsOrigin), "must be empty or a comma-separated list of exact https origins (no path, trailing slash, wildcard or credentials)")
    .transform((value) => value === "" ? [] : [...new Set(origins(value))]),
};
