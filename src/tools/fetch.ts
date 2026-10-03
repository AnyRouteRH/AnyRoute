import type { Ctx } from "../context.ts";
import { fail } from "../lib/errors.ts";
import { providerFetch } from "../providers/network.ts";
import { TOOL_CONTENT_TYPES } from "./config.ts";

// Egress for paid tools goes through the provider egress guard (providers/network.ts): HTTPS only in production,
// public addresses only with the DNS answer pinned to the socket, no redirects, no compressed bodies. Bodies are
// read with a hard byte cap, never trusting Content-Length alone.

export type ToolFetch = (url: string, init: RequestInit) => Promise<Response>;
export const TOOL_TIMEOUT_MS = 20_000;

export const egressFetch = (ctx: Ctx): ToolFetch => (url, init) => providerFetch(url, { ...init, redirect: "error" }, { production: ctx.cfg.production, allowDevelopmentMockLoopback: !ctx.cfg.production });

/** Validate a caller-supplied tool address: absolute http(s) (https in production), no credentials or fragment. */
export function toolUrl(ctx: Ctx, input: string): { url: URL; resource: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail(400, "resource must be an absolute https URL.", "invalid_request");
  }
  if (!(url.protocol === "https:" || (!ctx.cfg.production && url.protocol === "http:"))) fail(400, "resource must be an https URL.", "invalid_request");
  if (url.username || url.password || url.hash) fail(400, "resource must not carry credentials or a fragment.", "invalid_request");
  // The identity of a tool is its origin and path: the query (often per-call arguments) is never stored.
  return { url, resource: `${url.origin}${url.pathname}` };
}

/** Turn an egress error into a stable refusal. The URL, the body and the library text never reach a log. */
export function egressError(e: unknown): never {
  const name = (e as Error)?.name;
  const text = String((e as Error)?.message ?? "");
  if (/non-public address|must use HTTPS|cannot contain credentials/.test(text)) fail(400, "The tool address is not a public https destination.", "tool_destination_blocked");
  if (name === "TimeoutError" || name === "AbortError") fail(504, "The tool did not answer in time. Nothing was charged.", "tool_timeout");
  return fail(502, "The tool could not be reached. Nothing was charged.", "tool_unreachable");
}

/** Read at most `max` bytes. Returns null when the body is larger (the stream is cancelled). */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length")) > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The media type without parameters, lowercase. */
export const mediaType = (value: string | null) => (value ?? "").split(";")[0]!.trim().toLowerCase();
/** Plain text and JSON only: a tool answer is data for the caller, never markup, a script or a binary. */
export const allowedType = (type: string) => (TOOL_CONTENT_TYPES as readonly string[]).includes(type) || /^application\/[a-z0-9.+-]+\+json$/.test(type);
