import { z } from "zod";
import { fail } from "../lib/errors.ts";

export const SUITE = "x25519-aes-256-gcm-hkdf-sha256";
export const E2EE_HEADERS = ["x-e2ee-version", "x-client-pub-key", "x-model-pub-key", "x-e2ee-nonce", "x-e2ee-timestamp"];
export const MAX_ENVELOPE = 1024 * 1024;
export const MAX_WIRE = 32 * 1024 * 1024;
const hexField = z.string().regex(/^(?:[0-9a-f]{2}){60,}$/);
export const envelopeSchema = z.object({
  model: z.string().min(1).max(200),
  messages: z.array(z.object({ role: z.enum(["system", "developer", "user", "assistant"]), content: hexField }).strict()).min(1).max(128),
  max_tokens: z.number().int().min(1).max(32768),
  stream: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.literal(true) }).strict().optional(),
  provider: z.object({ aci_verified: z.literal(true), zdr: z.literal(true), aci_session_ids: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(8).optional() }).strict(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.literal(1).optional(),
}).strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export function validateEnvelope(bytes: Uint8Array, headers: Headers): Envelope {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail(400, "Invalid JSON envelope.", "invalid_request"); }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) fail(400, "Encrypted chat requires ciphertext content, an exact model, max_tokens and verified/ZDR provider constraints. Tools, files, search and unknown fields are refused.", "e2ee_unsupported_request");
  if (headers.has("x-signing-algo")) fail(400, "Legacy signing headers are refused.", "e2ee_invalid_version");
  if (headers.get("x-e2ee-version") !== "2") fail(400, "E2EE version 2 is required.", "e2ee_invalid_version");
  for (const h of ["x-client-pub-key", "x-model-pub-key"]) if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(headers.get(h) ?? "")) fail(400, "X25519 public keys are required.", "e2ee_invalid_public_key");
  if (!/^[0-9a-fA-F]{64}$/.test(headers.get("x-e2ee-nonce") ?? "")) fail(400, "A 32-byte replay nonce is required.", "e2ee_invalid_nonce");
  const ts = headers.get("x-e2ee-timestamp") ?? "";
  if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) fail(400, "E2EE timestamp is outside the acceptance window.", "e2ee_invalid_timestamp");
  if (parsed.data.stream && !parsed.data.stream_options) fail(400, "Streaming requires include_usage.", "invalid_request");
  return parsed.data;
}
/** One token per possible plaintext byte, plus framing overhead. A reservation bound, never observed usage. */
export const inputBound = (body: Envelope) => body.messages.reduce((n, m) => n + m.content.length / 2 - 60 + 256, 256);
export function reportedUsage(v: any) {
  const u = v?.usage;
  if (!u || !Number.isSafeInteger(u.prompt_tokens) || u.prompt_tokens < 0 || !Number.isSafeInteger(u.completion_tokens) || u.completion_tokens < 0 || u.prompt_tokens > 2147483647 || u.completion_tokens > 2147483647) return null;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  if (!Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > u.completion_tokens) return null;
  return { prompt: u.prompt_tokens, completion: u.completion_tokens, reasoning, cachedRead: 0, cacheWrite: 0, webSearch: 0, images: 0, estimated: false };
}
/** Bounded SSE observation; raw bytes are relayed separately and are never reconstructed. */
export class WireObserver {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  usage: ReturnType<typeof reportedUsage> = null;
  done = false;
  finish: string | null = null;
  feed(bytes: Uint8Array) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    if (this.pending.length > MAX_ENVELOPE) throw new Error("Oversized SSE event");
    let at: number;
    while ((at = this.pending.search(/\r?\n\r?\n/)) >= 0) {
      const match = this.pending.slice(at).match(/^\r?\n\r?\n/)![0];
      const block = this.pending.slice(0, at); this.pending = this.pending.slice(at + match.length);
      const data = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (this.done) throw new Error("Data after stream sentinel");
      if (data === "[DONE]") { this.done = true; continue; }
      const ev = JSON.parse(data);
      if (ev.error) throw new Error("Gateway stream error");
      this.usage = reportedUsage(ev) ?? this.usage;
      for (const c of ev.choices ?? []) if (typeof c.finish_reason === "string") this.finish = c.finish_reason;
    }
  }
  complete() { this.pending += this.decoder.decode(); return this.done && this.pending.trim() === "" && !!this.finish; }
}
